/**
 * "Your money has been paid out to your bank."
 *
 * A card payment lands in the user's Paystack subaccount, and Paystack pays
 * the subaccount out to their bank in its own batches — a "settlement". It
 * sends no webhook when that happens, so this asks its Settlements API every
 * hour: every successful settlement of the last week, the transactions inside
 * it, matched to our payments by reference. Each settlement is told once
 * (`payouts_told`, migration 0039).
 *
 * Proved on 5 October 2026 against the live account: the $1 test settled as
 * settlement 11966518, ₦1,279.09 on 4 October, holding exactly our reference.
 *
 * A naira invoice never comes here: it is paid straight into the user's bank
 * by their client, with no Paystack in between.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { clientNumber } from "../documents/client-number.ts";
import { b, lines, para } from "../whatsapp/format.ts";
import { send } from "../whatsapp/outbound.ts";

type Settlement = {
  id: number | string;
  status: string;
  total_amount: number;
  settlement_date: string | null;
  subaccount?: unknown;
};

const WEEK_MS = 7 * 86_400_000;

async function paystack<T>(path: string, fetchImpl: typeof fetch): Promise<T | null> {
  const res = await fetchImpl(`${env.PAYSTACK_BASE_URL.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { status?: boolean; data?: T } | null;
  return res.ok && body?.status ? (body.data ?? null) : null;
}

/** The words, in the chat. */
export function payoutMessage(x: {
  amountKobo: number;
  invoices: string[];
  account: string | null;
}): string {
  const which = x.invoices.length === 1 ? `invoice ${x.invoices[0]}` : `invoices ${x.invoices.join(", ")}`;
  return para(
    `💸 ${b("Paid out to your bank")}`,
    lines(
      `${b(formatNaira(x.amountKobo))} for ${which} has been sent to ${x.account ?? "your bank account"}.`,
      "Banks usually show it within a few hours.",
    ),
  );
}

export async function tellPayouts(log: FastifyBaseLogger, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!env.PAYSTACK_SECRET_KEY) return 0;
  const from = new Date(Date.now() - WEEK_MS).toISOString().slice(0, 10);
  const settlements = await paystack<Settlement[]>(`/settlement?from=${from}&perPage=100`, fetchImpl);
  if (!settlements) {
    log.warn("payouts: could not list settlements");
    return 0;
  }

  let told = 0;
  for (const s of settlements) {
    // A subaccount's, paid, with money in it. The integration's own share
    // (ours, from Balans fees) has no subaccount and nobody to tell.
    if (s.status !== "success" || !s.subaccount || !(s.total_amount > 0)) continue;
    const id = String(s.id);
    const { rows: seen } = await db().query(`SELECT 1 FROM payouts_told WHERE settlement_id = $1`, [id]);
    if (seen.length) continue;

    const txns = await paystack<{ reference: string }[]>(`/settlement/${id}/transactions`, fetchImpl);
    const refs = (txns ?? []).map((t) => t.reference).filter(Boolean);
    if (!refs.length) continue;

    const { rows } = await db().query<{
      payment_id: string;
      user_id: string;
      wa_phone: string;
      ref: string | null;
      number: number | null;
    }>(
      `SELECT p.id AS payment_id, d.user_id, u.wa_phone, d.ref, d.number
         FROM payments p
         JOIN documents d ON d.id = p.document_id
         JOIN users u ON u.id = d.user_id
        WHERE p.reference = ANY($1::text[]) AND p.provider = 'paystack' AND p.status = 'success'`,
      [refs],
    );
    // Not ours (or Pro, which pays Balans): remember it so it is not asked again.
    if (!rows.length || new Set(rows.map((r) => r.user_id)).size !== 1) {
      await db().query(
        `INSERT INTO payouts_told (settlement_id, amount_kobo, settled_on) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, s.total_amount, s.settlement_date?.slice(0, 10) ?? null],
      );
      continue;
    }

    const user = rows[0]!;
    const { rows: acct } = await db().query<{ bank_name: string; account_last4: string }>(
      `SELECT bank_name, account_last4 FROM bank_accounts WHERE user_id = $1 AND status = 'active'
        ORDER BY effective_at DESC NULLS LAST LIMIT 1`,
      [user.user_id],
    );
    const account = acct[0] ? `${acct[0].bank_name} ••${acct[0].account_last4}` : null;
    const invoices = [...new Set(rows.map((r) => clientNumber(r.ref, r.number) ?? "—"))];

    const outcome = await send(
      {
        userId: user.user_id,
        phone: user.wa_phone,
        text: payoutMessage({ amountKobo: s.total_amount, invoices, account }),
        fallback: {
          template: "payout_sent",
          params: [formatNaira(s.total_amount), invoices.join(", "), account ?? "your bank account"],
        },
      },
      log,
    );
    if (outcome.kind !== "sent") {
      // Tried again next hour, for as long as the settlement is in the week.
      log.warn({ settlement: id, userId: user.user_id, outcome: outcome.kind }, "payout not told yet");
      continue;
    }

    await db().query(
      `INSERT INTO payouts_told (settlement_id, user_id, amount_kobo, settled_on) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [id, user.user_id, s.total_amount, s.settlement_date?.slice(0, 10) ?? null],
    );
    await db().query(`UPDATE payments SET settled_at = COALESCE(settled_at, now()) WHERE id = ANY($1::uuid[])`, [
      rows.map((r) => r.payment_id),
    ]);
    told += 1;
    log.info({ settlement: id, userId: user.user_id, amountKobo: s.total_amount }, "payout told");
  }
  return told;
}
