/**
 * Writing to us after closing the account.
 *
 * The number went dead. `handleInbound` saw `status = 'closed'`, logged
 * "message from a closed account, ignored" and returned — so every message
 * after the closing one was read and dropped in silence. Somebody who closed
 * their account and changed their mind had no way back and no way to find out
 * there was none, because nothing ever answered.
 *
 * Reopening is easy to get wrong in the expensive direction, so this is
 * against a real database: what matters is which rows come back. The payout
 * account must not. Somebody asked us to disconnect it, and reviving it
 * because they said hello would point their money at an account they had
 * deliberately ended.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { reopenAccount, upsertUser, loadConversation, saveConversation } = await import("./store.ts");

describe("reopening a closed account", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;
  const phone = `234905${Date.now().toString().slice(-7)}`;

  before(async () => {
    const u = await upsertUser(phone);
    userId = u.id;
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  /** The state the account is in the moment after they confirm the deletion. */
  beforeEach(async () => {
    await db().query(`DELETE FROM bank_accounts WHERE user_id = $1`, [userId]);
    await db().query(`DELETE FROM risk_flags WHERE user_id = $1`, [userId]);

    await db().query(`UPDATE users SET business_name = 'Kemi Studio' WHERE id = $1`, [userId]);
    await saveConversation(userId, "awaiting_confirm", { draftId: "a-cancelled-document" });
    await db().query(
      `INSERT INTO bank_accounts
         (user_id, bank_code, bank_name, account_last4, account_number_encrypted, account_name, status)
       VALUES ($1, '044', 'Access bank', '5673', '\\x00'::bytea, 'DANIEL INIOBONG UWAK', 'retired')`,
      [userId],
    );
    await db().query(
      `INSERT INTO risk_flags (user_id, kind, detail, status)
       VALUES ($1, 'account_deletion', 'user asked to close their account', 'open')`,
      [userId],
    );
    await db().query(`UPDATE users SET status = 'closed', deleted_at = now() WHERE id = $1`, [userId]);
  });

  const user = async () =>
    (
      await db().query<{ status: string; business_name: string | null; deleted_at: Date | null }>(
        `SELECT status, business_name, deleted_at FROM users WHERE id = $1`,
        [userId],
      )
    ).rows[0]!;

  it("lets the account speak again", async () => {
    assert.equal((await user()).status, "closed", "closed to begin with");
    await reopenAccount(userId);
    assert.equal((await user()).status, "active");
  });

  it("clears the deletion date rather than leaving a live account marked deleted", async () => {
    await reopenAccount(userId);
    assert.equal((await user()).deleted_at, null);
  });

  it("does not bring the payout account back", async () => {
    /*
     * The one that costs money if it is wrong. They asked us to disconnect
     * where their money goes; a reopened account must ask again rather than
     * quietly resume paying into it.
     */
    await reopenAccount(userId);
    const { rows } = await db().query<{ status: string }>(
      `SELECT status FROM bank_accounts WHERE user_id = $1`,
      [userId],
    );
    assert.equal(rows.length, 1, "the row is kept for the ledger");
    assert.equal(rows[0]!.status, "retired", "but it is not live again");

    const active = await db().query(
      `SELECT 1 FROM bank_accounts WHERE user_id = $1 AND status IN ('active', 'pending')`,
      [userId],
    );
    assert.equal(active.rows.length, 0, "and nothing is queued to become live");
  });

  it("starts setup from the first question", async () => {
    await reopenAccount(userId);

    // A business name left in place means the form would be answering a
    // question it never asked, on behalf of an account that was closed.
    assert.equal((await user()).business_name, null);

    const c = await loadConversation(userId);
    assert.equal(c.state, "new");
    assert.deepEqual(c.context, {}, "and no draft from the old account");
  });

  it("withdraws the deletion job so nobody anonymises a live account", async () => {
    // The flag is a work item for a person: anonymise once the retention
    // period is up. Left open, that person does it to somebody who came back.
    await reopenAccount(userId);
    const { rows } = await db().query<{ status: string }>(
      `SELECT status FROM risk_flags WHERE user_id = $1 AND kind = 'account_deletion'`,
      [userId],
    );
    assert.equal(rows.length, 1, "the record of the request is kept");
    assert.equal(rows[0]!.status, "resolved");
  });

  it("can be closed and reopened again", async () => {
    // Nothing here is one-way, and somebody testing us is allowed to.
    await reopenAccount(userId);
    await db().query(`UPDATE users SET status = 'closed', deleted_at = now() WHERE id = $1`, [userId]);
    await reopenAccount(userId);
    assert.equal((await user()).status, "active");
  });

  it("leaves an account that was never closed alone", async () => {
    // reopenAccount is only ever called behind the closed check, but a wipe
    // of somebody's business name is not a thing to leave one branch away.
    await reopenAccount(userId);
    await db().query(`UPDATE users SET business_name = 'Kemi Studio' WHERE id = $1`, [userId]);
    await saveConversation(userId, "idle", {});

    const u = await upsertUser(phone);
    assert.equal(u.status, "active", "an ordinary message finds it active");
    assert.equal(u.businessName, "Kemi Studio", "and nothing has been cleared");
  });
});
