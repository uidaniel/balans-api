/**
 * Changing where the money goes (PRD F17).
 *
 * The highest-risk action in the product. Everything else a hijacked WhatsApp
 * account could do is embarrassing; this one redirects income. So F17 puts
 * four things in the way, and all four are here:
 *
 *   1. A code to the verified email, which is a second factor the phone does
 *      not control.
 *   2. The new account name resolved from the bank and confirmed out loud.
 *   3. A security alert to WhatsApp and email, so the real owner hears about
 *      it even if they are not the one doing it.
 *   4. A 24-hour delay before it takes effect. This is the one that actually
 *      saves somebody: an alert is only useful if there is still time to act
 *      on it.
 *
 * Until it takes effect, payments keep settling to the old account. That is
 * the safe direction to fail — money going to an account the user has had for
 * months is never the disaster.
 */

import type { FastifyBaseLogger } from "fastify";
import { db, tx } from "../db/pool.ts";
import { encrypt } from "../lib/crypto.ts";

/** F17 step 4. Long enough to notice an alert, short enough to be bearable. */
export const CHANGE_DELAY_HOURS = 24;

export type ActiveAccount = {
  id: string;
  bankName: string;
  last4: string;
  accountName: string;
  subAccountCode: string | null;
};

/**
 * The account payments settle to right now.
 *
 * "Right now" is the point: an account scheduled for tomorrow is `active` in
 * the table but not yet in force, and every payment path has to agree on that
 * or the delay means nothing.
 */
export async function accountInForce(userId: string): Promise<ActiveAccount | null> {
  const { rows } = await db().query<{
    id: string;
    bank_name: string;
    account_last4: string;
    account_name: string;
    subaccount_code: string | null;
  }>(
    `SELECT id, bank_name, account_last4, account_name, subaccount_code
       FROM bank_accounts
      WHERE user_id = $1
        AND status = 'active'
        AND (effective_at IS NULL OR effective_at <= now())
      ORDER BY effective_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [userId],
  );

  const r = rows[0];
  return r
    ? {
        id: r.id,
        bankName: r.bank_name,
        last4: r.account_last4,
        accountName: r.account_name,
        subAccountCode: r.subaccount_code,
      }
    : null;
}

/** A change that has been approved but has not come into force yet. */
export async function pendingChange(userId: string): Promise<{
  bankName: string;
  last4: string;
  accountName: string;
  effectiveAt: Date;
} | null> {
  const { rows } = await db().query<{
    bank_name: string;
    account_last4: string;
    account_name: string;
    effective_at: Date;
  }>(
    `SELECT bank_name, account_last4, account_name, effective_at
       FROM bank_accounts
      WHERE user_id = $1 AND status = 'active' AND effective_at > now()
      ORDER BY effective_at DESC LIMIT 1`,
    [userId],
  );

  const r = rows[0];
  return r
    ? {
        bankName: r.bank_name,
        last4: r.account_last4,
        accountName: r.account_name,
        effectiveAt: r.effective_at,
      }
    : null;
}

/**
 * Schedules the change.
 *
 * The old account is left exactly as it is. It keeps taking payments until the
 * new one comes into force, and `accountInForce` is what decides which that
 * is — so there is never a moment with no account at all, and never a moment
 * where a scheduled change is already live.
 */
export async function scheduleBankChange(
  userId: string,
  bank: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    subAccountCode: string;
  },
  log: FastifyBaseLogger,
): Promise<Date> {
  const effectiveAt = new Date(Date.now() + CHANGE_DELAY_HOURS * 3_600_000);

  await tx(async (c) => {
    // Any earlier scheduled change is replaced, not stacked. Two pending
    // changes is a question about which one wins, and there is no good answer.
    await c.query(
      `UPDATE bank_accounts SET status = 'retired'
        WHERE user_id = $1 AND status = 'active' AND effective_at > now()`,
      [userId],
    );

    await c.query(
      `INSERT INTO bank_accounts
         (user_id, bank_code, bank_name, account_last4, account_number_encrypted,
          account_name, provider, subaccount_code, status, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'monnify', $7, 'active', $8)`,
      [
        userId,
        bank.bankCode,
        bank.bankName,
        bank.accountNumber.slice(-4),
        encrypt(bank.accountNumber),
        bank.accountName,
        bank.subAccountCode,
        effectiveAt,
      ],
    );
  });

  log.warn(
    { userId, last4: bank.accountNumber.slice(-4), bank: bank.bankName, effectiveAt },
    "bank change scheduled",
  );

  return effectiveAt;
}

/** F17 step 5: admin can cancel a pending change. Also how a user undoes one. */
export async function cancelPendingChange(userId: string): Promise<boolean> {
  const { rowCount } = await db().query(
    `UPDATE bank_accounts SET status = 'retired'
      WHERE user_id = $1 AND status = 'active' AND effective_at > now()`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Retires accounts a newer one has superseded.
 *
 * Runs with the daily jobs. Nothing depends on it — `accountInForce` already
 * picks the right row — but leaving three active accounts on a user makes
 * every future query about "the" account ambiguous, and ambiguity about where
 * money goes is worth a housekeeping job.
 */
export async function retireSupersededAccounts(): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE bank_accounts b SET status = 'retired'
      WHERE b.status = 'active'
        AND (b.effective_at IS NULL OR b.effective_at <= now())
        AND EXISTS (
          SELECT 1 FROM bank_accounts newer
           WHERE newer.user_id = b.user_id
             AND newer.status = 'active'
             AND newer.id <> b.id
             AND (newer.effective_at IS NULL OR newer.effective_at <= now())
             AND COALESCE(newer.effective_at, newer.created_at)
                 > COALESCE(b.effective_at, b.created_at)
        )`,
  );
  return rowCount ?? 0;
}
