/**
 * "I've paid", tapped by the client on the invoice page (5 November 2026).
 *
 * A naira invoice is a transfer straight to the sender, which Balans cannot
 * see, and senders forget to mark it. So the client says it, and the sender
 * is asked to check their bank, with the same "Yes, mark paid" and "Not yet"
 * as the "Did they pay?" check, which already mark it the same way. Nothing
 * is marked paid by the client's word alone: the sender confirms.
 *
 * Told once per claim: inside the WhatsApp window as a message, outside it as
 * the `client_says_paid` template, and by email to a confirmed address.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { paidButtons } from "../jobs/overdue.ts";
import { send } from "../whatsapp/outbound.ts";
import { b, para } from "../whatsapp/format.ts";
import { sendEmail } from "../email/send.ts";
import { layout, paragraph } from "../email/layout.ts";
import { esc } from "./page.ts";

/** A client cannot ask again for this long: one press is one question. */
export const CLAIM_EVERY_HOURS = 12;

/**
 * Records the claim, if it is a fresh one on an invoice the sender marks
 * themselves and still owed. Returns whether it is new, so a second press
 * does not message the sender twice.
 */
export async function recordPaidClaim(documentId: string): Promise<boolean> {
  const { rowCount } = await db().query(
    `UPDATE documents SET client_paid_claim_at = now()
      WHERE id = $1
        AND type IN ('invoice', 'payment_request')
        AND status IN ('sent', 'viewed', 'overdue', 'part_paid')
        AND total_kobo > amount_paid_kobo
        AND (delivery_type IN ('bank_details', 'own_details') OR currency = 'NGN')
        AND (client_paid_claim_at IS NULL OR client_paid_claim_at < now() - make_interval(hours => $2::int))`,
    [documentId, CLAIM_EVERY_HOURS],
  );
  return (rowCount ?? 0) > 0;
}

export function claimText(client: string, number: number, owed: string): string {
  return para(
    `💸 ${b(`${client} says they've paid invoice #${number}`)}`,
    `${owed}. Balans cannot see your bank, so check it's there, then tap below. I won't remind them about it until you answer.`,
  );
}

/** Tells the sender. Never throws. */
export async function tellSenderClientPaid(documentId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const { rows } = await db().query<{
      user_id: string;
      wa_phone: string;
      number: number | null;
      owed: string;
      client_name: string | null;
      email: string | null;
      business_name: string | null;
    }>(
      `SELECT d.user_id, u.wa_phone, d.number, (d.total_kobo - d.amount_paid_kobo)::text AS owed,
              c.name AS client_name, u.business_name,
              CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END AS email
         FROM documents d JOIN users u ON u.id = d.user_id LEFT JOIN clients c ON c.id = d.client_id
        WHERE d.id = $1`,
      [documentId],
    );
    const r = rows[0];
    if (!r || r.number === null) return;
    const client = r.client_name ?? "Your client";
    const owed = formatNaira(Number(r.owed));
    const buttons = await paidButtons(documentId, r.number);

    const outcome = await send(
      {
        userId: r.user_id,
        phone: r.wa_phone,
        text: claimText(client, r.number, owed),
        buttons,
        fallback: {
          template: "client_says_paid",
          params: [client, `#${r.number}`, owed],
          payloads: buttons.map((x) => x.id),
        },
      },
      log,
    );
    if (outcome.kind !== "sent") log.warn({ documentId, outcome }, "could not tell the sender their client says they paid");

    if (r.email) {
      await sendEmail(
        {
          to: r.email,
          sender: "invoicing",
          subject: `${client} says they've paid invoice #${r.number}`,
          text: `${client} says they've paid invoice #${r.number} (${owed}).\n\nCheck your bank. Once it's there, mark it paid in WhatsApp: reply "mark invoice ${r.number} as paid" to Balans.`,
          html: layout({
            preheader: `${owed}. Check your bank, then mark it paid.`,
            heading: `${client} says they've paid invoice #${r.number}`,
            body: [
              paragraph(`${esc(owed)}. Balans cannot see your bank, so check it's there first. We won't remind them about it until you answer.`),
              paragraph(`Once it is, mark it paid in WhatsApp: reply <strong>mark invoice ${r.number} as paid</strong> to Balans.`, true),
            ].join("\n"),
          }),
        },
        log,
      );
    }
  } catch (err) {
    log.error({ err, documentId }, "telling the sender about a payment claim failed");
  }
}
