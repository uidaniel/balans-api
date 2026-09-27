/**
 * The Flow endpoint: where a form asks this server something before it closes.
 *
 * Since 26 September 2026 it answered one question: whose account is this?
 * "Check account" asks here, a number the bank does not know is said under
 * the Account box with everything still filled in, and one it does know comes
 * back with the name on it.
 *
 * Since 27 September it finishes the job too. The chat used to take over when
 * the form closed — a code emailed and a message saying so, a typed code, the
 * terms as a second form, then the card — four billable messages from October
 * and a typed code people got lost on. Now the form sends the code, checks it
 * on its own screen, records the terms and ends on a screen saying it worked.
 * Changing the bank later goes the same way. See `actions.ts` for what each
 * step actually does; this file only decides which step it is.
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
import * as actions from "./actions.ts";

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

/** What a PAYOUT screen sends when Check account is tapped. */
type PayoutAsk = {
  business_name?: string;
  email?: string;
  current_line?: string;
  /** "2" from the setup form that finishes itself; absent from the older one. */
  form_version?: string;
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

export const FORM_ERRORS = {
  notConfirmed: "Tick the box to say these details are correct.",
  notAgreed: "Tick the box to agree to the terms.",
  noAccount: "Go back and tap Check account again.",
  codeLength: "The code is 6 digits.",
} as const;

type Remembered = { bankCode: string; bankName: string; accountNumber: string; accountName: string };

/** Everything the endpoint can reach, so each branch is testable without a bank or a mailbox. */
export type Deps = {
  find?: (query: string) => Promise<{ code: string; name: string } | null>;
  check?: Checked;
  remember?: (userId: string, account: Remembered) => Promise<void>;
  recall?: (userId: string) => Promise<Remembered | null>;
  actions?: Partial<typeof actions>;
  log?: FastifyBaseLogger;
};

/** A logger that says nothing, for tests that pass none. */
const quiet = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

/** kemi@studio.ng -> k***@studio.ng. Enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name[0]}${"*".repeat(Math.max(1, Math.min(3, name.length - 1)))}@${domain}`;
}

const when = (d: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  }).format(d);

/**
 * One request in, one answer out, before encryption.
 *
 * Two forms ask this server anything: setup, and changing the bank later.
 * Both open on the same PAYOUT screen and both end on a code emailed to the
 * user, so the same three steps answer both, told apart by the token. The
 * token can be trusted: the route has already checked Meta's signature.
 */
export async function answer(req: FlowRequest, deps: Deps = {}): Promise<Record<string, unknown>> {
  if (req.action === "ping") return { data: { status: "active" } };

  // A client-side error report. Nothing to show; say it was heard.
  if (req.data && "error" in req.data) {
    deps.log?.warn({ error: req.data.error, message: req.data.error_message }, "flow reported an error");
    return { data: { acknowledged: true } };
  }

  const [key, userId] = (req.flow_token ?? "").split(":");
  const known = key === "onboarding" || key === "payout_change";
  if (req.action !== "data_exchange" || !known || !userId) {
    deps.log?.warn({ action: req.action, screen: req.screen, key }, "flow endpoint asked something it does not answer");
    return { data: { acknowledged: true } };
  }

  const log = deps.log ?? quiet;
  const act = { ...actions, ...deps.actions };
  const recall = deps.recall ?? recallChecked;
  const data = (req.data ?? {}) as Record<string, string | undefined>;

  if (req.screen === "PAYOUT") return checkPayout(key!, userId, data as PayoutAsk, deps);

  if (req.screen === "CONFIRM") {
    const checked = await recall(userId);
    const back = (field: string, message: string) => ({
      screen: "CONFIRM",
      data: { ...confirmData(key!, data), error_messages: { [field]: message } },
    });
    if (data.confirmed !== "true") return back("confirmed", FORM_ERRORS.notConfirmed);
    if (!checked) return back("confirmed", FORM_ERRORS.noAccount);

    if (key === "onboarding") {
      if (data.agreed !== "true") return back("agreed", FORM_ERRORS.notAgreed);
      const email = (data.email ?? "").trim().toLowerCase();
      const started = await act.startOnboarding(
        userId,
        { businessName: (data.business_name ?? "").trim(), email, checked },
        log,
      );
      return codeScreen({ email, masked: maskEmail(email) }, started.ok ? null : started.message);
    }

    const sent = await act.sendChangeCode(userId, log);
    if (!sent.ok) return back("confirmed", sent.message);
    return codeScreen({ email: sent.email, masked: maskEmail(sent.email) }, null);
  }

  if (req.screen === "CODE") {
    const email = (data.email ?? "").trim().toLowerCase();
    const shown = { email, masked: maskEmail(email) };

    if (data.resend === "1") {
      const again =
        key === "onboarding" ? await act.resendOnboardingCode(userId, email, log) : await act.sendChangeCode(userId, log);
      return codeScreen(shown, again.ok ? null : again.message, again.ok ? "A new code is on its way." : null);
    }

    const code = (data.code ?? "").replace(/\D/g, "");
    if (code.length !== 6) return codeScreen(shown, FORM_ERRORS.codeLength);

    const checked = await recall(userId);

    if (key === "onboarding") {
      const done = await act.finishOnboarding(userId, email, code, log);
      if (!done.ok) return codeScreen(shown, done.message);
      return {
        screen: "DONE",
        data: {
          account_name: checked?.accountName ?? "",
          account_line: checked ? `${checked.bankName} · ${checked.accountNumber}` : "",
        },
      };
    }

    if (!checked) return codeScreen(shown, FORM_ERRORS.noAccount);
    const made = await act.finishChange(userId, code, checked, log);
    if (!made.ok) return codeScreen(shown, made.message);
    return {
      screen: "DONE",
      data: {
        account_name: checked.accountName,
        account_line: `${checked.bankName} · ····${checked.accountNumber.slice(-4)}`,
        effective_line: `Payouts move here on ${when(made.effectiveAt)}. Until then they go to your current account.`,
      },
    };
  }

  log.warn({ key, screen: req.screen }, "flow endpoint asked about a screen it does not know");
  return { data: { acknowledged: true } };
}

/**
 * What CONFIRM shows, and nothing it does not declare.
 *
 * Meta checks an answer against the screen's `data` and refuses one that
 * carries a field the screen never mentioned, so the two forms' CONFIRM
 * screens get exactly their own fields back.
 */
function confirmData(key: string, d: Record<string, string | undefined>): Record<string, string> {
  return {
    ...(key === "onboarding" ? { business_name: d.business_name ?? "", email: d.email ?? "" } : {}),
    account_name: d.account_name ?? "",
    account_line: d.account_line ?? "",
  };
}

function codeScreen(
  shown: { email: string; masked: string },
  error: string | null,
  notice: string | null = null,
): Record<string, unknown> {
  return {
    screen: "CODE",
    data: {
      email: shown.email,
      masked_email: shown.masked,
      notice: notice ?? "",
      has_notice: Boolean(notice),
      error_messages: error ? { code: error } : {},
    },
  };
}

async function checkPayout(
  key: string,
  userId: string,
  ask: PayoutAsk,
  deps: Deps,
): Promise<Record<string, unknown>> {
  const carried =
    key === "onboarding"
      ? { business_name: ask.business_name ?? "", email: ask.email ?? "" }
      : { current_line: ask.current_line ?? "" };
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
    deps.log?.info({ userId, key, why: checked.why }, "form account check failed");
    return again(checked.why === "no_such_account" ? ACCOUNT_ERRORS.noSuchAccount : ACCOUNT_ERRORS.unreachable);
  }

  await (deps.remember ?? rememberChecked)(userId, {
    bankCode: bank.code,
    bankName: bank.name,
    accountNumber,
    accountName: checked.accountName,
  });

  /*
   * The older setup form, still open on somebody's phone or still the one
   * Meta has live if the new JSON was refused at publish. Its CONFIRM is the
   * last screen, closes the form itself, and declares a different set of
   * fields — and Meta refuses an answer that does not match what the screen
   * declares. So it gets the answer it was built for, and the chat finishes
   * setup for it the way it always did.
   */
  if (key === "onboarding" && ask.form_version !== "2") {
    return {
      screen: "CONFIRM",
      data: {
        business_name: ask.business_name ?? "",
        email: ask.email ?? "",
        bank: ask.bank ?? "",
        mfb_bank: ask.mfb_bank ?? "",
        account_number: accountNumber,
        account_name: checked.accountName,
        account_line: `${bank.name} · ${accountNumber}`,
      },
    };
  }

  return {
    screen: "CONFIRM",
    data: {
      ...confirmData(key, { business_name: ask.business_name, email: ask.email }),
      account_name: checked.accountName,
      account_line: `${bank.name} · ${accountNumber}`,
      error_messages: {},
    },
  };
}

/**
 * The name the bank gave, kept for the steps after it.
 *
 * Nothing that comes back through the client is trusted, so every later step
 * — the chat's, and this endpoint's own CONFIRM and CODE — takes the account
 * from here, never from its own payload.
 */
async function rememberChecked(userId: string, account: Remembered): Promise<void> {
  const { state, context } = await loadConversation(userId);
  await saveConversation(userId, state, { ...context, flowChecked: account });
}

async function recallChecked(userId: string): Promise<Remembered | null> {
  const { context } = await loadConversation(userId);
  const c = context.flowChecked;
  if (!c?.bankCode || !c.accountNumber || !c.accountName) return null;
  return {
    bankCode: c.bankCode,
    bankName: c.bankName ?? c.bankCode,
    accountNumber: c.accountNumber,
    accountName: c.accountName,
  };
}
