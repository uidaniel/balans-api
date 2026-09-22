/**
 * STOP cancels a scheduled payout change.
 *
 * This is the one message in the product that has to work. The security
 * notice says "reply STOP on WhatsApp and we will cancel it", and the
 * twenty-four hour delay exists so somebody whose WhatsApp has been taken
 * over has a window in which to use it.
 *
 * It did not work. "stop" reads as a rejection — the same list as "no" and
 * "cancel" — so at idle it answered "there is no draft waiting" and the
 * change went ahead on schedule. The cancel existed only on the confirmation
 * question, which is before the change is scheduled and not the moment anyone
 * needs it.
 *
 * Against a real database, because what has to be true is about rows: after
 * STOP there must be no account with a future effective_at, and the account
 * money goes to now must be the one it went to before.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { scheduleBankChange, cancelPendingChange, pendingChange, accountInForce } = await import(
  "./bank-change.ts"
);

describe("stopping a scheduled payout change", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;

  before(async () => {
    await db().query(`DELETE FROM users WHERE wa_phone LIKE '234904%' AND business_name = 'Stop Co'`);
    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Stop Co') RETURNING id`,
      [`234904${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  /** The account money goes to today. */
  const active = (over: Record<string, unknown> = {}) => ({
    bankCode: "044",
    bankName: "Access bank",
    accountNumber: "0123455673",
    accountName: "DANIEL INIOBONG UWAK",
    subAccountCode: "SUB_ORIGINAL",
    ...over,
  });

  beforeEach(async () => {
    await db().query(`DELETE FROM bank_accounts WHERE user_id = $1`, [userId]);
    // An account that has been in force for a while, so a change that later
    // takes effect is unambiguously the newer of the two.
    await db().query(
      `INSERT INTO bank_accounts
         (user_id, bank_code, bank_name, account_last4, account_number_encrypted,
          account_name, provider, status, subaccount_code, effective_at)
       VALUES ($1, '058', 'Sterling bank', '0475', $2, 'ORIGINAL NAME', 'monnify', 'active', 'SUB_OLD',
               now() - interval '2 days')`,
      [userId, Buffer.from("encrypted")],
    );
  });

  it("leaves nothing scheduled", async () => {
    await scheduleBankChange(userId, active(), console as never);
    assert.ok(await pendingChange(userId), "a change should be waiting");

    assert.equal(await cancelPendingChange(userId), true, "STOP should cancel it");
    assert.equal(await pendingChange(userId), null, "nothing may still be waiting");
  });

  it("leaves money going where it was going", async () => {
    const before = await accountInForce(userId);
    await scheduleBankChange(userId, active(), console as never);
    await cancelPendingChange(userId);

    const after = await accountInForce(userId);
    assert.equal(after?.last4, before?.last4, "the payout account moved");
    assert.equal(after?.subAccountCode, before?.subAccountCode);
  });

  it("says nothing happened when nothing was scheduled", async () => {
    // What tells the bot whether to claim it stopped something. Answering
    // "stopped" when there was nothing pending is its own kind of lie.
    assert.equal(await cancelPendingChange(userId), false);
  });

  it("cannot be used twice", async () => {
    await scheduleBankChange(userId, active(), console as never);
    assert.equal(await cancelPendingChange(userId), true);
    assert.equal(await cancelPendingChange(userId), false, "the second STOP stops nothing");
  });

  it("does not touch an account that has already taken effect", async () => {
    // The delay is over and this is simply the account now. STOP is not a way
    // to undo a change somebody made last week.
    await scheduleBankChange(userId, active(), console as never);
    await db().query(
      `UPDATE bank_accounts SET effective_at = now() - interval '1 hour'
        WHERE user_id = $1 AND subaccount_code = 'SUB_ORIGINAL'`,
      [userId],
    );

    assert.equal(await cancelPendingChange(userId), false, "an effective account is not pending");
    assert.equal((await accountInForce(userId))?.subAccountCode, "SUB_ORIGINAL");
  });
});
