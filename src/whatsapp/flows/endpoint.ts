/**
 * The Flow endpoint: where a form asks this server something before it closes.
 *
 * One question, since 26 September 2026: whose account is this? The setup
 * form used to collect a bank and ten digits, close, and have the chat
 * resolve them a second later — so a mistyped digit came back as a message
 * ("That account did not check out"), then another asking for the bank all
 * over again, with the form and everything typed into it gone. Now "Check
 * account" asks here first. A number the bank does not know is said under
 * the Account box, on the same screen, with everything still filled in; one
 * it does know comes back as a last screen with the name on it, and the chat
 * has nothing left to ask.
 *
 * Meta encrypts every request (RSA-OAEP over an AES-128-GCM key) and expects
 * the answer encrypted with the same key and the IV flipped. The private key
 * is ours, made once by `npm run flows -- --endpoint-key` and kept in the
 * `config` table encrypted under ENCRYPTION_KEY, so neither the repo nor a
 * copy of the database alone is enough to read a request.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/pool.ts";
import { decrypt, encrypt } from "../../lib/crypto.ts";
import { findBank, checkAccount } from "../../payments/bank-directory.ts";
import { loadConversation, saveConversation } from "../../conversation/store.ts";
import { MFB_CHOICE } from "./banks.ts";

const KEY_CONFIG = "flow_endpoint.private_key";

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

let cached: KeyObject | null = null;

/** The private key, or null when none has been made yet. */
export async function endpointKey(): Promise<KeyObject | null> {
  if (cached) return cached;
  const { rows } = await db().query<{ value: string }>(
    `SELECT value_json #>> '{}' AS value FROM config WHERE key = $1`,
    [KEY_CONFIG],
  );
  const stored = rows[0]?.value;
  if (!stored) return null;
  cached = createPrivateKey(decrypt(Buffer.from(stored, "base64")));
  return cached;
}

/**
 * A new key pair: the private half stored, the public half returned for Meta.
 *
 * Replacing the key breaks every form open at that moment until Meta has the
 * new public half, which the caller uploads straight after.
 */
export async function makeEndpointKey(): Promise<string> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await db().query(
    `INSERT INTO config (key, value_json, updated_by) VALUES ($1, to_jsonb($2::text), 'flows:endpoint-key')
       ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY_CONFIG, encrypt(privateKey).toString("base64")],
  );
  cached = null;
  return publicKey;
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                               */
/* -------------------------------------------------------------------------- */

export type Envelope = {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
};

export type FlowRequest = {
  version?: string;
  action: string;
  screen?: string;
  flow_token?: string;
  data?: Record<string, unknown>;
};

export type Opened = { request: FlowRequest; aesKey: Buffer; iv: Buffer };

const TAG = 16;

/** Throws when it cannot be read, which the route answers with 421. */
export function openEnvelope(body: Envelope, key: KeyObject): Opened {
  const aesKey = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(body.encrypted_aes_key, "base64"),
  );
  const iv = Buffer.from(body.initial_vector, "base64");
  const data = Buffer.from(body.encrypted_flow_data, "base64");
  const d = createDecipheriv("aes-128-gcm", aesKey, iv);
  d.setAuthTag(data.subarray(data.length - TAG));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]).toString("utf8");
  return { request: JSON.parse(plain) as FlowRequest, aesKey, iv };
}

/** The answer, under the request's key with every bit of the IV flipped. */
export function sealResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const c = createCipheriv("aes-128-gcm", aesKey, flipped);
  return Buffer.concat([c.update(JSON.stringify(response), "utf8"), c.final(), c.getAuthTag()]).toString("base64");
}

/* -------------------------------------------------------------------------- */
/* What it answers                                                            */
/* -------------------------------------------------------------------------- */

/** What the setup form's PAYOUT screen sends when Check account is tapped. */
type PayoutAsk = {
  business_name?: string;
  email?: string;
  bank?: string;
  mfb_bank?: string;
  account_number?: string;
};

export type Checked = (n: string, bank: { code: string; name: string }) => Promise<
  { ok: true; accountName: string } | { ok: false; why: "no_such_account" | "unreachable" }
>;

const liveCheck: Checked = async (n, bank) => {
  const r = await checkAccount(n, bank as Parameters<typeof checkAccount>[1]);
  if (r.ok) return { ok: true, accountName: r.account.accountName };
  return { ok: false, why: r.reason === "invalid_details" ? "no_such_account" : "unreachable" };
};

export const ACCOUNT_ERRORS = {
  length: "Account numbers are 10 digits.",
  noMfb: "Pick your microfinance bank in the MFB list above.",
  noBank: "Pick your bank again from the list above.",
  noSuchAccount: "This number is not an account at that bank. Check the number and the bank.",
  unreachable: "The bank did not answer just now. Tap Check account again in a minute.",
} as const;

/**
 * One request in, one answer out, before encryption.
 *
 * Pure but for the bank lookup and the note left for the chat, both passed
 * in, so every branch can be tested without a bank.
 */
export async function answer(
  req: FlowRequest,
  deps: {
    find?: (query: string) => Promise<{ code: string; name: string } | null>;
    check?: Checked;
    remember?: (userId: string, account: { bankCode: string; accountNumber: string; accountName: string }) => Promise<void>;
    log?: FastifyBaseLogger;
  } = {},
): Promise<Record<string, unknown>> {
  if (req.action === "ping") return { data: { status: "active" } };

  // A client-side error report. Nothing to show; say it was heard.
  if (req.data && "error" in req.data) {
    deps.log?.warn({ error: req.data.error, message: req.data.error_message }, "flow reported an error");
    return { data: { acknowledged: true } };
  }

  const [key, userId] = (req.flow_token ?? "").split(":");
  if (req.action !== "data_exchange" || key !== "onboarding" || req.screen !== "PAYOUT" || !userId) {
    deps.log?.warn({ action: req.action, screen: req.screen, key }, "flow endpoint asked something it does not answer");
    return { data: { acknowledged: true } };
  }

  const ask = (req.data ?? {}) as PayoutAsk;
  const carried = { business_name: ask.business_name ?? "", email: ask.email ?? "" };
  const again = (message: string) => ({
    screen: "PAYOUT",
    data: { ...carried, error_messages: { account_number: message } },
  });

  const accountNumber = (ask.account_number ?? "").replace(/\D/g, "");
  if (accountNumber.length !== 10) return again(ACCOUNT_ERRORS.length);

  const chosen = (ask.bank ?? "").trim();
  const query = chosen === MFB_CHOICE ? (ask.mfb_bank ?? "").trim() : chosen;
  if (!query) return again(chosen === MFB_CHOICE ? ACCOUNT_ERRORS.noMfb : ACCOUNT_ERRORS.noBank);

  const bank = await (deps.find ?? findBank)(query);
  if (!bank) return again(ACCOUNT_ERRORS.noBank);

  const checked = await (deps.check ?? liveCheck)(accountNumber, bank);
  if (!checked.ok) {
    deps.log?.info({ userId, why: checked.why }, "setup form account check failed");
    return again(checked.why === "no_such_account" ? ACCOUNT_ERRORS.noSuchAccount : ACCOUNT_ERRORS.unreachable);
  }

  await (deps.remember ?? rememberChecked)(userId, {
    bankCode: bank.code,
    accountNumber,
    accountName: checked.accountName,
  });

  return {
    screen: "CONFIRM",
    data: {
      ...carried,
      bank: ask.bank ?? "",
      mfb_bank: ask.mfb_bank ?? "",
      account_number: accountNumber,
      account_name: checked.accountName,
      account_line: `${bank.name} · ${accountNumber}`,
    },
  };
}

/**
 * The name the bank gave, kept for the chat.
 *
 * The finished form carries the name back through the client, and nothing
 * that comes back from there is trusted. So the chat takes the name from
 * here, and only for the same bank and number the form finished with.
 */
async function rememberChecked(
  userId: string,
  account: { bankCode: string; accountNumber: string; accountName: string },
): Promise<void> {
  const { state, context } = await loadConversation(userId);
  await saveConversation(userId, state, { ...context, flowChecked: account });
}
