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
 * providers' codes are different namespaces with no mapping between them.
 * Accounts added before 26 September 2026 hold Monnify's code; later ones
 * hold Paystack's (`provider = 'paystack'`), which is used as it is. Sent to Paystack it is refused at best,
 * and at worst names a different institution — which is somebody's money
 * settling somewhere else. So it is translated by *name*, exactly, and a name
 * that does not match produces no subaccount rather than a near miss.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { decrypt } from "../lib/crypto.ts";
import { cachedBanks, createSubAccount, matchByName } from "./paystack.ts";

export type SubaccountResult =
  | { ok: true; code: string; created: boolean }
  | { ok: false; why: "no_bank" | "unknown_bank" | "provider"; message: string };

type Row = {
  id: string;
  bank_name: string;
  bank_code: string;
  provider: string;
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
    `SELECT b.id, b.bank_name, b.bank_code, b.provider, b.account_number_encrypted, b.paystack_subaccount_code,
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

  // The same list the Pay button was drawn from. Two different lists here
  // would mean a button that appears and then refuses.
  const banks = await cachedBanks();
  // An account chosen from Paystack's list (every one since 26 September
  // 2026) already holds Paystack's code; only older, Monnify-coded rows have
  // to be translated by name.
  const match =
    bank.provider === "paystack"
      ? (banks.find((b) => b.code === bank.bank_code) ?? { name: bank.bank_name, code: bank.bank_code })
      : matchByName(bank.bank_name, banks);
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

/**
 * Whether a card could be taken for this user at all, without creating
 * anything.
 *
 * The page needs this before it draws the Pay button. Card payment failing is
 * not a transient event to report after the fact — it is a standing condition
 * of the sender's payout account, and the client cannot do anything about it
 * however many times they press.
 *
 * It was reported after the fact, and the result was a page arguing with
 * itself: "Card payment is not available on this invoice yet" rendered
 * directly above a live "Pay by card" button, because the invoice really was
 * payable. Hiding the button on that error instead was worse in its own way —
 * the error lives in the query string so a reload kept it, and the page stayed
 * dead even once the cause was fixed.
 *
 * So the button follows the condition rather than the last attempt. Same rules
 * as `paystackSubaccountFor` and deliberately so: a check that could disagree
 * with the thing it is gating would eventually hide a button that works, or
 * show one that cannot.
 *
 * Optimistic when Paystack cannot be reached: an empty bank list is our
 * outage, not the freelancer's, and the honest answer then is to let them
 * press Pay and get a retryable error.
 */
export async function cardPaymentAvailable(userId: string): Promise<boolean> {
  const { rows } = await db().query<{ bank_name: string; paystack_subaccount_code: string | null }>(
    `SELECT b.bank_name, b.paystack_subaccount_code
       FROM bank_accounts b
      WHERE b.user_id = $1
        AND b.status = 'active'
        AND (b.effective_at IS NULL OR b.effective_at <= now())
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [userId],
  );

  const bank = rows[0];
  if (!bank) return false;
  if (bank.paystack_subaccount_code) return true;

  const banks = await cachedBanks();
  if (banks.length === 0) return true;
  return matchByName(bank.bank_name, banks) !== null;
}
