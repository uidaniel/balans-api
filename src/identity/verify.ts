/**
 * Verifying the person behind an account that takes card payments from
 * abroad (20 October 2026). See migration 0059 for why, and dojah.ts for the
 * provider.
 *
 * Two steps, the second only when it is needed:
 *
 *   1. The person. A selfie that is a live face, matched to the photo on
 *      their NIN. Their legal name comes back from the NIN record, so it is
 *      never typed.
 *   2. Their payout account. The bank already told us the name on it. If the
 *      NIN's first name and surname are both in it, the account is theirs and
 *      they are verified. If not, it is usually a business account: they give
 *      its RC or BN number, and the CAC register must show the same business
 *      name with them as a director, proprietor or partner.
 *
 * Anything that does not line up goes to a person (`review`), with an alert,
 * rather than through. Each attempt costs money at the provider, so there are
 * three a day.
 */

import { randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { encrypt } from "../lib/crypto.ts";
import { accountInForce } from "../settings/bank-change.ts";
import { cacLookup, identityConfigured, liveness, ninWithSelfie, type CompanyType } from "./dojah.ts";
import { businessMatchesAccount, personMatchesAccount, samePerson, type Person } from "./names.ts";

export type IdentityStatus = "none" | "person" | "verified" | "review";

export const ATTEMPTS_A_DAY = 3;

/** Whether card invoices abroad need a verified person: only once the provider is set up. */
export const identityRequired = (): boolean => identityConfigured();

export async function identityStatusOf(userId: string): Promise<IdentityStatus> {
  const { rows } = await db().query<{ s: IdentityStatus }>(
    `SELECT identity_status AS s FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.s ?? "none";
}

/* -- The page's link ------------------------------------------------------ */

/** Reused while live, a day from each issue: the signature link's rule. */
export async function issueIdentityToken(userId: string): Promise<string> {
  const { rows } = await db().query<{ identity_token: string }>(
    `UPDATE users
        SET identity_token = COALESCE(
              CASE WHEN identity_token_expires_at > now() THEN identity_token END,
              $2),
            identity_token_expires_at = now() + interval '1 day'
      WHERE id = $1
      RETURNING identity_token`,
    [userId, randomBytes(16).toString("hex")],
  );
  return rows[0]!.identity_token;
}

export type IdentityOwner = {
  id: string;
  phone: string;
  businessName: string | null;
  status: IdentityStatus;
  legalName: string | null;
};

export async function ownerOfIdentityToken(token: string): Promise<IdentityOwner | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    business_name: string | null;
    identity_status: IdentityStatus;
    legal_name: string | null;
  }>(
    `SELECT id, wa_phone, business_name, identity_status, legal_name FROM users
      WHERE identity_token = $1 AND identity_token_expires_at > now() AND status = 'active'`,
    [token],
  );
  const r = rows[0];
  return r
    ? { id: r.id, phone: r.wa_phone, businessName: r.business_name, status: r.identity_status, legalName: r.legal_name }
    : null;
}

/* -- The record ------------------------------------------------------------ */

async function record(
  userId: string,
  kind: "liveness" | "nin_selfie" | "name_match" | "cac",
  outcome: "passed" | "failed" | "error",
  reason: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db().query(
    `INSERT INTO identity_checks (user_id, kind, outcome, reason, detail_json) VALUES ($1, $2, $3, $4, $5)`,
    [userId, kind, outcome, reason, JSON.stringify(detail)],
  );
}

/** Paid attempts in the last day: one per selfie sent, one per CAC lookup. */
async function attemptsToday(userId: string, kind: "liveness" | "cac"): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM identity_checks
      WHERE user_id = $1 AND kind = $2 AND outcome <> 'error' AND created_at > now() - interval '1 day'`,
    [userId, kind],
  );
  return rows[0]?.n ?? 0;
}

async function setStatus(userId: string, status: IdentityStatus): Promise<void> {
  await db().query(
    `UPDATE users SET identity_status = $2,
            identity_verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE identity_verified_at END
      WHERE id = $1`,
    [userId, status],
  );
}

/* -- Step 1: the person ---------------------------------------------------- */

export type PersonOutcome =
  | { kind: "verified" }
  | { kind: "business_needed"; accountName: string }
  | { kind: "no_account" }
  | { kind: "bad_nin" }
  | { kind: "not_live" }
  | { kind: "no_match" }
  | { kind: "nin_not_found" }
  | { kind: "too_many" }
  | { kind: "unavailable" };

export async function verifyPerson(
  userId: string,
  nin: string,
  selfie: string,
  log: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<PersonOutcome> {
  if (!/^\d{11}$/.test(nin)) return { kind: "bad_nin" };
  if ((await identityStatusOf(userId)) === "verified") return { kind: "verified" };
  if ((await attemptsToday(userId, "liveness")) >= ATTEMPTS_A_DAY) return { kind: "too_many" };

  // Counted as the attempt whether or not the liveness call is made.
  if (env.IDENTITY_LIVENESS === "true") {
    const live = await liveness(selfie, fetchImpl);
    if (!live.ok) {
      await record(userId, "liveness", "error", live.message, { status: live.status });
      log.error({ userId, status: live.status, message: live.message }, "IDENTITY CHECK UNAVAILABLE — liveness");
      return { kind: "unavailable" };
    }
    if (!live.live) {
      await record(userId, "liveness", "failed", "not a live face", { probability: live.probability, faces: live.faces });
      return { kind: "not_live" };
    }
    await record(userId, "liveness", "passed", null, { probability: live.probability });
  } else {
    await record(userId, "liveness", "passed", "liveness switched off", {});
  }

  const r = await ninWithSelfie(nin, selfie, fetchImpl);
  if (!r.ok) {
    const notFound = r.status === 404 || r.status === 400;
    await record(userId, "nin_selfie", notFound ? "failed" : "error", r.message, { status: r.status, nin_last4: nin.slice(-4) });
    if (!notFound) log.error({ userId, status: r.status, message: r.message }, "IDENTITY CHECK UNAVAILABLE — nin");
    return { kind: notFound ? "nin_not_found" : "unavailable" };
  }
  const p = r.record;
  if (!p.match) {
    await record(userId, "nin_selfie", "failed", "selfie does not match the NIN photo", {
      confidence: p.confidence,
      nin_last4: nin.slice(-4),
    });
    return { kind: "no_match" };
  }

  const legal = [p.first, p.middle, p.last].filter(Boolean).join(" ");
  await record(userId, "nin_selfie", "passed", null, {
    confidence: p.confidence,
    nin_last4: nin.slice(-4),
    first: p.first,
    middle: p.middle,
    last: p.last,
  });
  await db().query(
    `UPDATE users SET legal_name = $2, nin_encrypted = $3, nin_last4 = $4, identity_status = 'person' WHERE id = $1`,
    [userId, legal, encrypt(nin), nin.slice(-4)],
  );
  return tieAccount(userId, p, log);
}

/** Step 2a: the payout account in the person's own name. */
async function tieAccount(userId: string, p: Person, log: FastifyBaseLogger): Promise<PersonOutcome> {
  const account = await accountInForce(userId);
  if (!account) return { kind: "no_account" };
  if (personMatchesAccount(p, account.accountName)) {
    await record(userId, "name_match", "passed", null, { account_name: account.accountName });
    await setStatus(userId, "verified");
    log.info({ userId }, "identity verified");
    return { kind: "verified" };
  }
  await record(userId, "name_match", "failed", "NIN name is not the payout account's name", {
    account_name: account.accountName,
  });
  return { kind: "business_needed", accountName: account.accountName };
}

/** The person as the NIN check recorded them, for the business step. */
async function verifiedPerson(userId: string): Promise<Person | null> {
  const { rows } = await db().query<{ d: { first?: string; middle?: string | null; last?: string } }>(
    `SELECT detail_json AS d FROM identity_checks
      WHERE user_id = $1 AND kind = 'nin_selfie' AND outcome = 'passed'
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const d = rows[0]?.d;
  return d?.first && d.last ? { first: d.first, middle: d.middle ?? null, last: d.last } : null;
}

/* -- Step 2b: a business account ------------------------------------------- */

export type BusinessOutcome =
  | { kind: "verified" }
  | { kind: "review" }
  | { kind: "not_found" }
  | { kind: "bad_number" }
  | { kind: "person_first" }
  | { kind: "too_many" }
  | { kind: "unavailable" };

export async function verifyBusiness(
  userId: string,
  regNumber: string,
  type: CompanyType,
  log: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<BusinessOutcome> {
  const number = regNumber.replace(/^(RC|BN)\s*/i, "").replace(/\s+/g, "");
  if (!/^\d{3,10}$/.test(number)) return { kind: "bad_number" };
  if ((await identityStatusOf(userId)) === "verified") return { kind: "verified" };
  const person = await verifiedPerson(userId);
  if (!person) return { kind: "person_first" };
  if ((await attemptsToday(userId, "cac")) >= ATTEMPTS_A_DAY) return { kind: "too_many" };

  const account = await accountInForce(userId);
  if (!account) return { kind: "person_first" };

  const r = await cacLookup(number, type, fetchImpl);
  if (!r.ok) {
    const notFound = r.status === 404 || r.status === 400;
    await record(userId, "cac", notFound ? "failed" : "error", r.message, { status: r.status, number, type });
    if (!notFound) log.error({ userId, status: r.status, message: r.message }, "IDENTITY CHECK UNAVAILABLE — cac");
    return { kind: notFound ? "not_found" : "unavailable" };
  }

  const c = r.record;
  const nameOk = businessMatchesAccount(c.name, account.accountName);
  const listed = c.people.some((x) => samePerson(person, x));
  const detail = { number, type, company_name: c.name, status: c.status, account_name: account.accountName, listed };

  if (nameOk && listed) {
    await record(userId, "cac", "passed", null, detail);
    await db().query(`UPDATE users SET business_reg_number = $2 WHERE id = $1`, [userId, `${type === "COMPANY" ? "RC" : "BN"}${number}`]);
    await setStatus(userId, "verified");
    log.info({ userId }, "identity verified through the CAC register");
    return { kind: "verified" };
  }

  await record(userId, "cac", "failed", nameOk ? "not listed on the CAC record" : "business name is not the account's", detail);
  await setStatus(userId, "review");
  log.error({ userId, ...detail, nameOk }, "IDENTITY NEEDS REVIEW — business account did not line up");
  return { kind: "review" };
}

/** "My account is in my name, spelt differently": a person looks. */
export async function requestReview(userId: string, note: string, log: FastifyBaseLogger): Promise<void> {
  if ((await identityStatusOf(userId)) === "verified") return;
  await setStatus(userId, "review");
  log.error({ userId, note: note.slice(0, 300) }, "IDENTITY NEEDS REVIEW — asked for by the user");
}
