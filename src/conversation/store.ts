/**
 * Persistence for the conversation (PRD sections 5 and 7).
 *
 * The state machine is pure; this is the only part that touches the database.
 * Keeping them apart is what lets every path through onboarding be tested by
 * calling a function, with no database in sight.
 */

import { db, tx } from "../db/pool.ts";
import type { Context, State } from "./machine.ts";
import { defaults } from "../config.ts";

export type User = {
  id: string;
  waPhone: string;
  businessName: string | null;
  status: "active" | "paused" | "closed";
};

/**
 * Finds the user behind a WhatsApp number, creating them on first contact.
 *
 * `ON CONFLICT` rather than select-then-insert: two webhooks for the same new
 * number can arrive at once — Meta batches, and retries overlap — and a check
 * followed by an insert would race and violate the unique index.
 */
export async function upsertUser(waPhone: string): Promise<User> {
  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    business_name: string | null;
    status: User["status"];
  }>(
    `INSERT INTO users (wa_phone) VALUES ($1)
     ON CONFLICT (wa_phone) DO UPDATE SET wa_phone = EXCLUDED.wa_phone
     RETURNING id, wa_phone, business_name, status`,
    [waPhone],
  );
  const r = rows[0]!;
  return { id: r.id, waPhone: r.wa_phone, businessName: r.business_name, status: r.status };
}

export type Conversation = { state: State; context: Context };

export async function loadConversation(userId: string): Promise<Conversation> {
  const { rows } = await db().query<{ state: string; context_json: Context; last_inbound_at: Date | null }>(
    `SELECT state, context_json, last_inbound_at FROM conversations WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { state: "new", context: {} };

  // Section 5: state expires to idle after 24 hours. Someone returning the next
  // day should not land mid-question with no idea what was being asked.
  const idleFor = row.last_inbound_at ? Date.now() - row.last_inbound_at.getTime() : 0;
  const expired = idleFor > defaults.behaviour.stateExpiryHours * 3_600_000;
  if (expired && row.state !== "new" && row.state !== "paused") {
    // Part-finished onboarding is worth resuming; an abandoned draft is not.
    const resumable = row.state.startsWith("onboarding");
    return resumable
      ? { state: row.state as State, context: row.context_json ?? {} }
      : { state: "idle", context: {} };
  }

  return { state: row.state as State, context: row.context_json ?? {} };
}

export async function saveConversation(
  userId: string,
  state: State,
  context: Context,
): Promise<void> {
  await db().query(
    `INSERT INTO conversations (user_id, state, context_json, last_inbound_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (user_id) DO UPDATE
       SET state = EXCLUDED.state,
           context_json = EXCLUDED.context_json,
           last_inbound_at = EXCLUDED.last_inbound_at,
           updated_at = now()`,
    [userId, state, JSON.stringify(context)],
  );
}

/**
 * Records a message we have seen or sent.
 *
 * Returns false if this inbound id was already stored, which is how a redelivered
 * webhook becomes a no-op instead of a second reply. Meta retries on any doubt,
 * so this is the difference between answering once and answering three times.
 */
export async function recordInbound(
  userId: string,
  waMessageId: string,
  kind: string,
): Promise<boolean> {
  const { rowCount } = await db().query(
    `INSERT INTO messages (user_id, wa_message_id, direction, kind, status)
     VALUES ($1, $2, 'in', $3, 'received')
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [userId, waMessageId, kind],
  );
  return rowCount === 1;
}

/**
 * Logs a message that went out (PRD F16).
 *
 * Window state and estimated cost on every one, so "cost per completed
 * invoice" is a query rather than a guess. A reply is always inside the
 * window by definition — it is a reply — which is why that is the default.
 */
export async function recordOutbound(
  userId: string,
  waMessageId: string | null,
  status: string,
  opts: { inWindow?: boolean; kind?: string; template?: string | null } = {},
): Promise<void> {
  const { costOf } = await import("../whatsapp/window.ts");
  const inWindow = opts.inWindow ?? true;
  // Only a delivered message costs anything.
  const cost = status === "sent" ? costOf({ inWindow }) : 0;

  await db().query(
    `INSERT INTO messages
       (user_id, wa_message_id, direction, kind, template, in_window, cost_estimate_kobo, status)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, $7)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [userId, waMessageId, opts.kind ?? "text", opts.template ?? null, inWindow, cost, status],
  );
}

/** Keeps the business name on the user row once onboarding captures it. */
export async function setBusinessName(userId: string, name: string): Promise<void> {
  await db().query(`UPDATE users SET business_name = $2 WHERE id = $1`, [userId, name]);
}

/** Records the address a code was sent to. Not yet verified. */
export async function setEmail(userId: string, email: string): Promise<void> {
  await db().query(
    `UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1`,
    [userId, email.toLowerCase()],
  );
}

export async function markEmailVerified(userId: string, email: string): Promise<void> {
  await db().query(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [userId, email.toLowerCase()],
  );
}

export type PendingBank = {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  email: string | null;
};

/**
 * Stores the account the bank confirmed, as `pending`.
 *
 * Pending, not active: the user has not yet agreed that the name is theirs, and
 * the unique index allows only one active account per user. Nothing settles
 * anywhere until they confirm and a subaccount exists.
 */
export async function saveBankAccount(
  userId: string,
  bank: { bankCode: string; bankName: string; accountNumber: string; accountName: string },
): Promise<void> {
  const { encrypt } = await import("../lib/crypto.ts");

  // Replace any earlier unconfirmed attempt rather than accumulating them.
  await db().query(
    `DELETE FROM bank_accounts WHERE user_id = $1 AND status = 'pending' AND subaccount_code IS NULL`,
    [userId],
  );

  await db().query(
    `INSERT INTO bank_accounts
       (user_id, bank_code, bank_name, account_last4, account_number_encrypted, account_name, provider, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'monnify', 'pending')`,
    [
      userId,
      bank.bankCode,
      bank.bankName,
      bank.accountNumber.slice(-4),
      encrypt(bank.accountNumber),
      bank.accountName,
    ],
  );
}

export async function getPendingBank(userId: string): Promise<PendingBank | null> {
  const { rows } = await db().query<{
    bank_code: string;
    bank_name: string;
    account_number_encrypted: Buffer;
    account_name: string;
    email: string | null;
  }>(
    `SELECT b.bank_code, b.bank_name, b.account_number_encrypted, b.account_name, u.email
       FROM bank_accounts b JOIN users u ON u.id = b.user_id
      WHERE b.user_id = $1 AND b.status = 'pending'
      ORDER BY b.created_at DESC LIMIT 1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;

  const { decrypt } = await import("../lib/crypto.ts");
  return {
    bankCode: r.bank_code,
    bankName: r.bank_name,
    accountNumber: decrypt(r.account_number_encrypted),
    accountName: r.account_name,
    email: r.email,
  };
}

/**
 * Brings a closed account back, as an empty one.
 *
 * Closing is not a wall. Somebody who closed their account and then writes
 * again has changed their mind, which is the ordinary reason to write to us,
 * and the number going quiet on them is the worst answer available.
 *
 * What comes back is the account, not the setup. The payout account was
 * retired when they closed and stays retired; the business name goes here.
 * Setup then runs from the first question, so nobody is handed back an
 * arrangement they had asked us to end — least of all a bank account that
 * money would go to.
 *
 * The ledger is untouched. Records of money that moved were never ours to
 * delete, and the closing message says so.
 */
export async function reopenAccount(userId: string): Promise<void> {
  await tx(async (c) => {
    await c.query(
      `UPDATE users SET status = 'active', deleted_at = NULL, business_name = NULL WHERE id = $1`,
      [userId],
    );

    /*
     * The deletion flag is a job for a person: anonymise the personal data
     * once the retention period is up. Left open it would have somebody
     * anonymise an account that is live again, so reopening withdraws it.
     */
    await c.query(
      `UPDATE risk_flags SET status = 'resolved'
        WHERE user_id = $1 AND kind = 'account_deletion' AND status = 'open'`,
      [userId],
    );

    // Whatever the conversation was doing when it closed is gone with it. An
    // old draft id would point at a document the closing cancelled.
    await c.query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
  });
}

/**
 * Makes the pending account the live one.
 *
 * Any previous active account is retired in the same statement, because the
 * unique index permits exactly one active account per user — which is what
 * stops a half-finished bank change leaving money going to two places.
 */
export async function activateBankAccount(userId: string, subAccountCode: string): Promise<void> {
  await tx(async (c) => {
    await c.query(
      `UPDATE bank_accounts SET status = 'retired' WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    await c.query(
      `UPDATE bank_accounts
          SET status = 'active', subaccount_code = $2, effective_at = now()
        WHERE id = (SELECT id FROM bank_accounts
                     WHERE user_id = $1 AND status = 'pending'
                     ORDER BY created_at DESC LIMIT 1)`,
      [userId, subAccountCode],
    );
  });
}

/**
 * Stamps which version of the terms was accepted, and when (section 12).
 *
 * The version matters as much as the fact: when the terms change we have to
 * know who agreed to which text.
 */
export async function recordConsent(
  userId: string,
  version: string,
): Promise<{ first: boolean; email: string | null; businessName: string | null }> {
  /*
   * Also says whether this finished signing up, which is what the welcome
   * email is sent on. Agreeing is the last step, and it is taken again
   * whenever the terms change — so "first" is read off the activation stamp,
   * which is only ever set once, rather than off the agreement itself.
   * `now()` is fixed for the statement, so a stamp set just now equals it.
   *
   * The email only comes back verified: a welcome sent to an address nobody
   * proved they own is a welcome sent to a stranger.
   */
  const { rows } = await db().query<{ first: boolean; email: string | null; business_name: string | null }>(
    `UPDATE users
        SET consent_version = $2, consented_at = now(), activated_setup_at = COALESCE(activated_setup_at, now())
      WHERE id = $1
  RETURNING activated_setup_at = now() AS first,
            CASE WHEN email_verified_at IS NOT NULL THEN email END AS email,
            business_name`,
    [userId, version],
  );
  const r = rows[0];
  return { first: r?.first ?? false, email: r?.email ?? null, businessName: r?.business_name ?? null };
}

/**
 * Whether they have ever chosen an invoice design.
 *
 * Only used to decide whether to keep offering the picker. Somebody who has
 * picked is not asked again on every invoice; `/design` still works.
 */
export async function hasChosenTemplate(userId: string): Promise<boolean> {
  const { rows } = await db().query<{ chosen: boolean }>(
    `SELECT template_id IS NOT NULL AS chosen FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.chosen ?? false;
}
