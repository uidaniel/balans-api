/**
 * The Paystack subaccount a user's international share settles into
 * (International PRD section 8).
 *
 * One bank account, two references to it. Every naira invoice splits through
 * Monnify's subaccount; an invoice priced abroad is a card payment and splits
 * through this one. They are two processors' names for the same account, kept
 * as two columns on one row rather than as two rows, because the thing the
 * user verified and owns is the bank account — and a bank change that had to
 * remember to move both would be a bank change that eventually forgot.
 *
 * Made on demand rather than during onboarding. Almost nobody invoices
 * abroad, and asking Paystack to create an account for every freelancer who
 * signs up would be a call we make thousands of times for the handful of
 * users who need it — and one more thing that can fail between somebody
 * typing their account number and being told they are set up.
 *
 * The bank code is the awkward part and it is worth being loud about: the two
 * providers' codes are different namespaces with no mapping between them. The
 * stored `bank_code` is Monnify's. Sent to Paystack it is refused at best,
 * and at worst names a different institution — which is somebody's money
 * settling somewhere else. So it is translated by *name*, exactly, and a name
 * that does not match produces no subaccount rather than a near miss.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { decrypt } from "../lib/crypto.ts";
import { createSubAccount, listBanks, matchByName } from "./paystack.ts";

export type SubaccountResult =
  | { ok: true; code: string; created: boolean }
  | { ok: false; why: "no_bank" | "unknown_bank" | "provider"; message: string };

type Row = {
  id: string;
  bank_name: string;
  account_number_encrypted: Buffer;
  paystack_subaccount_code: string | null;
  business_name: string | null;
  email: string | null;
};

/**
 * The user's Paystack subaccount code, creating it the first time.
 *
 * Returns a reason rather than throwing, because every one of them needs
 * different words said to somebody: no payout account at all is a setup that
 * was never finished, a bank Paystack does not list is a support job, and a
 * provider failure is worth trying again in a minute.
 */
export async function paystackSubaccountFor(
  userId: string,
  log: FastifyBaseLogger,
): Promise<SubaccountResult> {
  const { rows } = await db().query<Row>(
    `SELECT b.id, b.bank_name, b.account_number_encrypted, b.paystack_subaccount_code,
            u.business_name, u.email
       FROM bank_accounts b
       JOIN users u ON u.id = b.user_id
      WHERE b.user_id = $1
        AND b.status = 'active'
        AND (b.effective_at IS NULL OR b.effective_at <= now())
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [userId],
  );

  const bank = rows[0];
  if (!bank) return { ok: false, why: "no_bank", message: "no active payout account" };
  if (bank.paystack_subaccount_code) {
    return { ok: true, code: bank.paystack_subaccount_code, created: false };
  }

  const banks = await listBanks();
  const match = matchByName(bank.bank_name, banks);
  if (!match) {
    /*
     * Loud, because it is a dead end for this user until somebody acts. Their
     * naira invoicing is unaffected, so nothing is broken — they simply
     * cannot be paid by card, and no amount of retrying will change that.
     */
    log.error(
      { userId, bankName: bank.bank_name },
      "paystack does not list this bank under a name we can match",
    );
    return { ok: false, why: "unknown_bank", message: `no Paystack code for ${bank.bank_name}` };
  }

  const made = await createSubAccount({
    businessName: bank.business_name ?? "Balans user",
    accountNumber: decrypt(bank.account_number_encrypted),
    bankCode: match.code,
    email: bank.email ?? `user-${userId}@receipts.balans.ng`,
  });

  if (!made.ok) {
    log.error({ userId, message: made.message, retryable: made.retryable }, "paystack subaccount failed");
    return { ok: false, why: "provider", message: made.message };
  }

  /*
   * Stored against the bank account, not the user, so that changing banks
   * takes the subaccount with it — a stale code here would settle a card
   * payment into the account somebody moved away from.
   */
  await db().query(
    `UPDATE bank_accounts
        SET paystack_subaccount_code = $2, paystack_subaccount_status = 'active'
      WHERE id = $1`,
    [bank.id, made.account.subaccountCode],
  );

  log.info({ userId, subaccount: made.account.subaccountCode }, "paystack subaccount created");
  return { ok: true, code: made.account.subaccountCode, created: true };
}
