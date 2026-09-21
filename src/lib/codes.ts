/**
 * One-time codes for email verification and, later, bank changes (PRD F17).
 *
 * The code is shown to the person once and never stored. What is stored is an
 * HMAC of it keyed with the encryption key, so a database dump does not let
 * anyone complete a verification or redirect someone's settlement account.
 *
 * Three things make this safe rather than merely functional: a limit on how
 * many codes can be requested, a limit on how many guesses each code takes, and
 * a constant-time comparison so the wrong answer takes the same time as the
 * right one.
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "../db/pool.ts";
import { env, require_ } from "../config.ts";

export type Purpose = "email_verify" | "bank_change" | "recover_number";

const TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
/** Codes per purpose within the window, to stop the mailbox being a weapon. */
const MAX_ISSUED = 3;
const ISSUE_WINDOW_MINUTES = 15;

function hash(code: string, purpose: Purpose, destination: string): Buffer {
  require_("ENCRYPTION_KEY");
  // Purpose and destination are bound into the digest, so a code issued for one
  // email cannot be replayed against another, or against a bank change.
  return createHmac("sha256", Buffer.from(env.ENCRYPTION_KEY!, "base64"))
    .update(`${purpose}\u0000${destination.toLowerCase()}\u0000${code}`)
    .digest();
}

/**
 * Six digits, uniformly distributed.
 *
 * `randomInt` rather than `Math.random`: the latter is predictable, and this
 * code is the only thing standing between an attacker and someone's payouts.
 * Leading zeros are kept — "042318" is a perfectly good code.
 */
function generate(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type IssueResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: "rate_limited"; retryAfterMinutes: number };

export async function issueCode(
  userId: string,
  purpose: Purpose,
  destination: string,
): Promise<IssueResult> {
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM verification_codes
      WHERE user_id = $1 AND purpose = $2
        AND created_at > now() - ($3 || ' minutes')::interval`,
    [userId, purpose, ISSUE_WINDOW_MINUTES],
  );
  if (Number(rows[0]?.n ?? 0) >= MAX_ISSUED) {
    return { ok: false, reason: "rate_limited", retryAfterMinutes: ISSUE_WINDOW_MINUTES };
  }

  const code = generate();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000);

  // Any earlier live code for this purpose stops working the moment a new one
  // is sent, so only the most recent email is ever valid.
  await db().query(
    `UPDATE verification_codes SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  );

  await db().query(
    `INSERT INTO verification_codes (user_id, purpose, destination, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, purpose, destination.toLowerCase(), hash(code, purpose, destination), expiresAt],
  );

  return { ok: true, code, expiresAt };
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "no_code" | "expired" | "too_many_attempts" | "wrong"; left?: number };

export async function checkCode(
  userId: string,
  purpose: Purpose,
  destination: string,
  code: string,
): Promise<CheckResult> {
  const { rows } = await db().query<{
    id: string;
    code_hash: Buffer;
    attempts: number;
    expires_at: Date;
  }>(
    `SELECT id, code_hash, attempts, expires_at FROM verification_codes
      WHERE user_id = $1 AND purpose = $2 AND destination = $3 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose, destination.toLowerCase()],
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: "no_code" };
  if (row.expires_at.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const given = hash(code.replace(/\D/g, ""), purpose, destination);
  // Same length by construction, so this cannot throw, and it does not leak
  // through how long it takes.
  const match = given.length === row.code_hash.length && timingSafeEqual(given, row.code_hash);

  if (!match) {
    const { rows: after } = await db().query<{ attempts: number }>(
      `UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [row.id],
    );
    const used = after[0]?.attempts ?? MAX_ATTEMPTS;
    return { ok: false, reason: "wrong", left: Math.max(0, MAX_ATTEMPTS - used) };
  }

  // Consumed on success, so a code works exactly once (section 11: magic links
  // and codes are single use).
  await db().query(`UPDATE verification_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
  return { ok: true };
}

/** Daily cleanup (section 10: purge expired tokens). */
export async function purgeExpiredCodes(): Promise<number> {
  const { rowCount } = await db().query(
    `DELETE FROM verification_codes WHERE expires_at < now() - interval '1 day'`,
  );
  return rowCount ?? 0;
}
