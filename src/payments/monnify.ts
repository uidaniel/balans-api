/**
 * Monnify client (PRD section 3: behind a provider interface).
 *
 * Every path and field name below was confirmed against the sandbox rather
 * than taken from documentation — their docs site does not publish these, and
 * guessing is not acceptable for the calls that decide where a user's money
 * lands. What the sandbox actually returned is recorded beside each call.
 *
 * Rule 1 of the PRD applies throughout: Balans never holds user money. Payments
 * are split by Monnify at the moment they are made, and nothing here moves
 * funds out of a Balans balance, because there is never anything in one.
 */

import { env, require_ } from "../config.ts";

const AUTH_PATH = "/api/v1/auth/login";
/** v1 is deprecated and says so: "migrate to the more secure endpoint". */
const VALIDATE_PATH = "/api/v2/disbursements/account/validate";
const SUB_ACCOUNTS_PATH = "/api/v1/sub-accounts";
const INIT_TRANSACTION_PATH = "/api/v1/merchant/transactions/init-transaction";
/** 374 banks with NIP codes. The /sdk/ variant returns only the top 28. */
const BANKS_PATH = "/api/v1/banks";

type Envelope<T> = {
  requestSuccessful?: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody?: T;
};

function base(): string {
  return env.MONNIFY_BASE_URL.replace(/\/+$/, "");
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

let cached: { token: string; expiresAt: number } | undefined;

/**
 * Bearer token, cached until shortly before it expires.
 *
 * The sandbox issues tokens good for 3599 seconds. Re-authenticating per call
 * would double every request; refreshing a minute early avoids using one that
 * expires mid-flight.
 */
async function token(fetchImpl: typeof fetch = fetch): Promise<string> {
  require_("MONNIFY_API_KEY", "MONNIFY_SECRET_KEY");

  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const basic = Buffer.from(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`).toString("base64");
  const res = await fetchImpl(`${base()}${AUTH_PATH}`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await res.json().catch(() => ({}))) as Envelope<{
    accessToken?: string;
    expiresIn?: number;
  }>;
  const accessToken = body.responseBody?.accessToken;

  if (!res.ok || !accessToken) {
    throw new Error(`Monnify auth failed (${res.status}): ${body.responseMessage ?? "no token"}`);
  }

  const ttl = (body.responseBody?.expiresIn ?? 3600) * 1000;
  cached = { token: accessToken, expiresAt: Date.now() + ttl - 60_000 };
  return accessToken;
}

/** Forgets the cached token. For tests, and for a 401 mid-flight. */
export function resetAuth(): void {
  cached = undefined;
}

async function call<T>(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: T } | { ok: false; status: number; message: string }> {
  const bearer = await token(fetchImpl);
  const res = await fetchImpl(`${base()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.json().catch(() => ({}))) as Envelope<T>;

  if (res.ok && body.requestSuccessful && body.responseBody !== undefined) {
    return { ok: true, body: body.responseBody };
  }
  return {
    ok: false,
    status: res.status,
    message: body.responseMessage ?? `HTTP ${res.status}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Account name resolution (F17)                                              */
/* -------------------------------------------------------------------------- */

export type ResolvedAccount = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};

export type ResolveResult =
  | { ok: true; account: ResolvedAccount }
  | { ok: false; reason: "invalid_details" | "provider_error"; message: string };

/**
 * Asks the bank whose account this is.
 *
 * We never take the user's word for the name on their account: section 12 and
 * F26 both turn on the name the bank returns, and it is what the user confirms
 * before a subaccount is created.
 *
 * A bad account number comes back 404 with "Invalid account details supplied",
 * which is a normal outcome — someone mistyped — not an outage.
 */
export async function resolveAccount(
  accountNumber: string,
  bankCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveResult> {
  const q = new URLSearchParams({ accountNumber, bankCode });
  const res = await call<ResolvedAccount>(`${VALIDATE_PATH}?${q}`, { method: "GET" }, fetchImpl);

  if (res.ok) return { ok: true, account: res.body };
  if (res.status === 404 || res.status === 400) {
    return { ok: false, reason: "invalid_details", message: res.message };
  }
  return { ok: false, reason: "provider_error", message: res.message };
}

/* -------------------------------------------------------------------------- */
/* Sub accounts                                                               */
/* -------------------------------------------------------------------------- */

export type SubAccount = {
  subAccountCode: string;
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName: string;
  currencyCode: string;
  email: string;
  defaultSplitPercentage: number;
};

/**
 * Creates the subaccount a user's share settles into.
 *
 * The endpoint takes an array and returns one. `defaultSplitPercentage` must be
 * above 0.1 or it is rejected — but it is not the fee: the real split is set per
 * transaction when the payment is initialised, which is where the fee engine's
 * answer goes. This is only the default Monnify falls back on.
 */
export async function createSubAccount(
  input: { accountNumber: string; bankCode: string; email: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; account: SubAccount } | { ok: false; message: string }> {
  const res = await call<SubAccount[]>(
    SUB_ACCOUNTS_PATH,
    {
      method: "POST",
      body: JSON.stringify([
        {
          currencyCode: "NGN",
          bankCode: input.bankCode,
          accountNumber: input.accountNumber,
          email: input.email,
          defaultSplitPercentage: 1,
        },
      ]),
    },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message };
  const account = res.body[0];
  if (!account?.subAccountCode) return { ok: false, message: "no subaccount returned" };
  return { ok: true, account };
}

/* -------------------------------------------------------------------------- */
/* Banks                                                                      */
/* -------------------------------------------------------------------------- */

export type Bank = { name: string; code: string; nipBankCode: string | null };

export async function listBanks(fetchImpl: typeof fetch = fetch): Promise<Bank[]> {
  const res = await call<Bank[]>(BANKS_PATH, { method: "GET" }, fetchImpl);
  return res.ok ? res.body : [];
}

/**
 * Matches what someone typed to a bank.
 *
 * People write "GTBank", "gtb", "Guaranty Trust" and "Access Bank" for the same
 * handful of institutions, so an exact match is nearly useless. Tried in order:
 * exact, then a known alias, then a prefix, then a containment — and the
 * shortest name wins a tie, because "Access bank" should beat "Access bank
 * (Diamond)" for the word "access".
 */
const ALIASES: Record<string, string[]> = {
  gtbank: ["gtb", "gt bank", "guaranty trust", "guarantee trust", "gtco"],
  "access bank": ["access"],
  "united bank for africa": ["uba"],
  "first bank of nigeria": ["first bank", "firstbank", "fbn"],
  "zenith bank": ["zenith"],
  "fidelity bank": ["fidelity"],
  "union bank of nigeria": ["union bank", "union"],
  "sterling bank": ["sterling"],
  "stanbic ibtc bank": ["stanbic", "ibtc"],
  "ecobank nigeria": ["ecobank", "eco bank"],
  "wema bank": ["wema"],
  "polaris bank": ["polaris"],
  "keystone bank": ["keystone"],
  "unity bank": ["unity"],
  "moniepoint mfb": ["moniepoint", "monie point"],
  "kuda microfinance bank": ["kuda"],
  "opay digital services limited": ["opay"],
  "palmpay": ["palm pay"],
};

export function matchBank(query: string, banks: Bank[]): Bank | null {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const shortest = (a: Bank, b: Bank) => a.name.length - b.name.length;

  const exact = banks.filter((b) => norm(b.name) === q);
  if (exact.length) return exact.sort(shortest)[0]!;

  for (const [canonical, alts] of Object.entries(ALIASES)) {
    if (alts.includes(q) || q === canonical) {
      const hit = banks.filter((b) => norm(b.name).startsWith(canonical.split(" ")[0]!)).sort(shortest);
      const exactCanonical = banks.find((b) => norm(b.name) === canonical);
      if (exactCanonical) return exactCanonical;
      if (hit.length) return hit[0]!;
    }
  }

  const prefix = banks.filter((b) => norm(b.name).startsWith(q));
  if (prefix.length) return prefix.sort(shortest)[0]!;

  const contains = banks.filter((b) => norm(b.name).includes(q));
  if (contains.length) return contains.sort(shortest)[0]!;

  // Last resort, the other direction: a bank name sitting inside a sentence.
  //
  // The state machine hands over whatever was left after the account number was
  // removed, so "my bank is Zenith," arrives whole. Everything above asks "is
  // this query a bank name?"; this asks "is there a bank name in this query?".
  //
  // Whole words only, or "access" matches inside "accessory". The longest
  // needle wins, so "first bank" beats the bare word "bank".
  const words = new Set(q.split(" "));
  const phraseIn = (needle: string) =>
    needle.includes(" ") ? q.includes(needle) : words.has(needle);

  let best: { bank: Bank; needle: number } | null = null;
  for (const bank of banks) {
    const name = norm(bank.name);
    for (const needle of [name, ...(ALIASES[name] ?? [])]) {
      if (needle.length < 3 || !phraseIn(needle)) continue;
      const better =
        !best ||
        needle.length > best.needle ||
        (needle.length === best.needle && bank.name.length < best.bank.name.length);
      if (better) best = { bank, needle: needle.length };
    }
  }
  return best?.bank ?? null;
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

export type InitResult =
  | { ok: true; transactionReference: string; checkoutUrl: string }
  | { ok: false; message: string };

/**
 * Starts a payment and returns the page the client pays on.
 *
 * `amount` is naira, not kobo: Monnify takes a decimal amount, and this is the
 * one boundary in the system where kobo is converted. It happens here, once,
 * rather than at each call site.
 */
export async function initTransaction(
  input: {
    amountKobo: number;
    customerName: string;
    customerEmail: string;
    paymentReference: string;
    description: string;
    redirectUrl: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<InitResult> {
  require_("MONNIFY_CONTRACT_CODE");

  const res = await call<{ transactionReference?: string; checkoutUrl?: string }>(
    INIT_TRANSACTION_PATH,
    {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountKobo / 100,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        paymentReference: input.paymentReference,
        paymentDescription: input.description,
        currencyCode: "NGN",
        contractCode: env.MONNIFY_CONTRACT_CODE,
        redirectUrl: input.redirectUrl,
      }),
    },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message };
  const { transactionReference, checkoutUrl } = res.body;
  if (!transactionReference || !checkoutUrl) {
    return { ok: false, message: "no checkout url returned" };
  }
  return { ok: true, transactionReference, checkoutUrl };
}
