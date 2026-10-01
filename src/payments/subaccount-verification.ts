/**
 * Keeping every Paystack subaccount verified.
 *
 * Paystack, 1 October 2026: "the amount allocated to [an unverified]
 * subaccount is held back until verification is complete … postponed
 * indefinitely until you verify it manually via the dashboard", and there is
 * no API to verify. Subaccounts made through the API start unverified. So a
 * client could pay a Balans user and the money would sit at Paystack until
 * somebody on staff happened to look — the opposite of "paid straight to
 * you".
 *
 * Three things close that:
 *   - `ensureSubaccountEarly`: a user gets their subaccount the moment they
 *     become Pro (cards are Pro) or change bank on Pro, not when their client
 *     first pays, so it can be verified before any money is waiting on it.
 *   - `checkSubaccounts`: hourly, asks Paystack which are verified and keeps
 *     `bank_accounts.paystack_subaccount_status` at 'verified' or
 *     'unverified', which the admin reads.
 *   - `emailUnverifiedDigest`: once a day while any are unverified, tells
 *     the admins, with the link to the page where they tick them.
 *
 * Never deletes or deactivates a subaccount: Paystack does not reroute a
 * pending payout from one, it waits for it to come back.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { sendEmail } from "../email/send.ts";
import { layout, paragraph, button } from "../email/layout.ts";
import { paystackSubaccountFor } from "./paystack-subaccount.ts";

export const PAYSTACK_SUBACCOUNTS_URL = "https://dashboard.paystack.com/#/subaccounts";

/** Whether Paystack has verified this subaccount. Null when it cannot be asked. */
export async function subaccountVerified(code: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  if (!env.PAYSTACK_SECRET_KEY) return null;
  try {
    const res = await fetchImpl(`${env.PAYSTACK_BASE_URL.replace(/\/$/, "")}/subaccount/${encodeURIComponent(code)}`, {
      headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { is_verified?: boolean } };
    return body.data?.is_verified === true;
  } catch {
    return null;
  }
}

/**
 * Makes sure a Pro user has a subaccount now, so it can be verified before a
 * client pays. Quiet and never fatal: if it cannot be made now, the first
 * card payment makes it, as before.
 */
export function ensureSubaccountEarly(userId: string, log: FastifyBaseLogger): void {
  if (!env.PAYSTACK_SECRET_KEY || !env.INTL_ENABLED) return;
  void paystackSubaccountFor(userId, log)
    .then((r) => {
      if (r.ok && r.created) log.info({ userId }, "paystack subaccount made early, to be verified before any payment");
    })
    .catch((err: unknown) => log.warn({ userId, err: (err as Error).message }, "could not make the subaccount early"));
}

/** Hourly: records which subaccounts Paystack has verified. Returns how many are still waiting. */
export async function checkSubaccounts(log: FastifyBaseLogger, fetchImpl: typeof fetch = fetch): Promise<number> {
  // Pro users with a payout account and no subaccount yet — made Pro from
  // the admin, or before this existed, or whose bank changed — get one now.
  if (env.INTL_ENABLED) {
    const { rows: missing } = await db().query<{ user_id: string }>(
      `SELECT b.user_id FROM bank_accounts b JOIN users u ON u.id = b.user_id
        WHERE u.plan = 'pro' AND u.status = 'active' AND b.status = 'active'
          AND (b.effective_at IS NULL OR b.effective_at <= now())
          AND b.paystack_subaccount_code IS NULL`,
    );
    for (const m of missing) {
      await paystackSubaccountFor(m.user_id, log).catch((err: unknown) =>
        log.warn({ userId: m.user_id, err: (err as Error).message }, "could not make a subaccount in the sweep"),
      );
    }
  }

  const { rows } = await db().query<{ id: string; code: string }>(
    `SELECT id, paystack_subaccount_code AS code FROM bank_accounts
      WHERE paystack_subaccount_code IS NOT NULL
        AND status = 'active'
        AND paystack_subaccount_status IS DISTINCT FROM 'verified'`,
  );
  let waiting = 0;
  for (const r of rows) {
    const verified = await subaccountVerified(r.code, fetchImpl);
    if (verified === null) {
      waiting += 1;
      continue;
    }
    await db().query(`UPDATE bank_accounts SET paystack_subaccount_status = $2 WHERE id = $1`, [
      r.id,
      verified ? "verified" : "unverified",
    ]);
    if (!verified) waiting += 1;
    else log.info({ bankAccountId: r.id }, "paystack subaccount verified");
  }
  return waiting;
}

/**
 * Once a day while any subaccount is unverified: an email to every admin,
 * with how many and where to go. The day is remembered in `config`, so a
 * restart does not send a second one.
 */
export async function emailUnverifiedDigest(log: FastifyBaseLogger, now = new Date()): Promise<void> {
  const { rows } = await db().query<{ business_name: string | null }>(
    `SELECT u.business_name FROM bank_accounts b JOIN users u ON u.id = b.user_id
      WHERE b.status = 'active' AND b.paystack_subaccount_status = 'unverified'
      ORDER BY u.business_name`,
  );
  if (!rows.length) return;

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(now);
  const { rows: sent } = await db().query<{ value: string }>(
    `SELECT value_json #>> '{}' AS value FROM config WHERE key = 'subaccount_digest_sent_on'`,
  );
  if (sent[0]?.value === today) return;

  const { rows: admins } = await db().query<{ email: string }>(
    `SELECT email FROM admin_allowlist WHERE role = 'admin' AND email IS NOT NULL`,
  );
  if (!admins.length) return;

  const n = rows.length;
  const names = rows.map((r) => r.business_name ?? "A Balans user");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const subject = `${n} Paystack subaccount${n === 1 ? "" : "s"} to verify`;
  const html = layout({
    preheader: "Payouts to them are held by Paystack until you do.",
    heading: subject,
    body: [
      paragraph(
        `Paystack holds a client's card payment to an unverified subaccount until it is verified in the dashboard, and there is no way to do it automatically.`,
      ),
      paragraph(`Waiting: <strong>${names.map(esc).join(", ")}</strong>.`),
      paragraph("Tick each one on the Subaccounts page, then press Verify subaccounts.", true),
      button("Open Paystack subaccounts", PAYSTACK_SUBACCOUNTS_URL),
    ].join("\n"),
  });
  const text = [
    subject,
    "",
    "Paystack holds a client's card payment to an unverified subaccount until it is verified in the dashboard.",
    "",
    `Waiting: ${names.join(", ")}.`,
    "",
    `Open: ${PAYSTACK_SUBACCOUNTS_URL}`,
  ].join("\n");

  for (const a of admins) await sendEmail({ to: a.email, subject, html, text }, log).catch(() => undefined);
  await db().query(
    `INSERT INTO config (key, value_json, updated_by) VALUES ('subaccount_digest_sent_on', $1::jsonb, 'subaccounts')
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()`,
    [JSON.stringify(today)],
  );
  log.warn({ count: n }, "unverified paystack subaccounts: admins emailed");
}
