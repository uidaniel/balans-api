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
const VERIFY_TRANSACTION_PATH = "/api/v2/transactions";
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
export async function listSubAccounts(fetchImpl: typeof fetch = fetch): Promise<SubAccount[]> {
  const res = await call<SubAccount[]>(SUB_ACCOUNTS_PATH, { method: "GET" }, fetchImpl);
  return res.ok ? res.body : [];
}

/** The existing subaccount for an account number, if the merchant has one. */
export async function findSubAccount(
  accountNumber: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubAccount | null> {
  const all = await listSubAccounts(fetchImpl);
  return all.find((a) => a.accountNumber === accountNumber) ?? null;
}

export type CreateSubAccountResult =
  | { ok: true; account: SubAccount; reused?: boolean }
  | {
      ok: false;
      message: string;
      /**
       * Whether sending the same details again could ever work.
       *
       * A 5xx is the provider failing and worth one more go. A 4xx is a
       * judgement about these details, and repeating them is how a person
       * ends up sending their account number six times to the same refusal.
       */
      retryable: boolean;
    };

export async function createSubAccount(
  input: { accountNumber: string; bankCode: string; email: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CreateSubAccountResult> {
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

  if (!res.ok) {
    // Monnify refuses a second subaccount for an account number it already
    // holds. That is not a failure: somebody re-running setup, or an earlier
    // attempt that got this far before stopping, should end up with the
    // subaccount that exists rather than a dead end.
    if (/already exists/i.test(res.message)) {
      const existing = await findSubAccount(input.accountNumber, fetchImpl);
      if (existing) return { ok: true, account: existing, reused: true };
    }
    return { ok: false, message: res.message, retryable: res.status >= 500 };
  }

  const account = res.body[0];
  if (!account?.subAccountCode) {
    return { ok: false, message: "no subaccount returned", retryable: true };
  }
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
  // Monnify lists the bank as "First City Monument Bank Plc" and a separate
  // wallet as "FCMB MOBILE". Without this, the abbreviation everybody uses
  // matches only the wallet.
  "first city monument bank": ["fcmb", "first city monument"],
  "jaiz bank": ["jaiz"],
  "providus bank": ["providus"],
  "titan bank": ["titan"],
  "globus bank": ["globus"],
  "taj bank": ["taj"],
  "lotus bank": ["lotus"],
  "suntrust bank": ["suntrust", "sun trust"],
  "premium trust bank": ["premium trust", "premiumtrust"],
  "parallex bank": ["parallex"],
  "citibank nigeria": ["citibank", "citi bank", "citi"],
  "heritage bank": ["heritage"],
  "standard chartered bank": ["standard chartered", "stanchart"],
  "vfd microfinance bank": ["vfd"],
  "paga": ["paga"],
};

/**
 * A bank that can actually receive a settlement.
 *
 * Nigeria's three-digit CBN codes belong to licensed banks. The longer codes
 * are NIP-only routes: mobile wallets, agent networks and some microfinance
 * banks. Both resolve an account name perfectly well, which is the trap — a
 * wallet passes every check we make and then fails at subaccount creation,
 * after the user has confirmed their name and thinks they are done.
 *
 * So when several entries match one name, the licensed bank wins. "OPAY 3"
 * and "PAYCOM (OPAY)" are the same institution; only one of them settles.
 */
const isLicensedBank = (b: Bank): boolean => /^\d{3}$/.test(b.code);

export function matchBank(query: string, banks: Bank[]): Bank | null {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  /** Licensed bank first, then the plainer name. */
  const best = (a: Bank, b: Bank) =>
    Number(isLicensedBank(b)) - Number(isLicensedBank(a)) || a.name.length - b.name.length;

  // Aliases before exact matches. An alias is a curated statement about what
  // people mean; an exact match is a coincidence of spelling, and Monnify's
  // list contains both "Globus" (a NIP route) and "Globus Bank" (the bank).
  // Someone typing "globus" means the bank.
  for (const [canonical, alts] of Object.entries(ALIASES)) {
    if (!alts.includes(q) && q !== canonical) continue;
    // Every spelling of this bank, so "opay" finds "PAYCOM (OPAY)" too — the
    // one that does not start with the word being searched for.
    const needles = [canonical, ...alts];
    const hits = banks.filter((b) => {
      const name = norm(b.name);
      return needles.some((needle) => name.includes(needle));
    });
    if (hits.length) return hits.sort(best)[0]!;
  }

  const exact = banks.filter((b) => norm(b.name) === q);
  if (exact.length) return exact.sort(best)[0]!;

  const prefix = banks.filter((b) => norm(b.name).startsWith(q));
  if (prefix.length) return prefix.sort(best)[0]!;

  const contains = banks.filter((b) => norm(b.name).includes(q));
  if (contains.length) return contains.sort(best)[0]!;

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

  let found: { bank: Bank; needle: number } | null = null;
  for (const bank of banks) {
    const name = norm(bank.name);
    for (const needle of [name, ...(ALIASES[name] ?? [])]) {
      if (needle.length < 3 || !phraseIn(needle)) continue;
      const better =
        !found ||
        needle.length > found.needle ||
        (needle.length === found.needle && isLicensedBank(bank) && !isLicensedBank(found.bank)) ||
        (needle.length === found.needle &&
          isLicensedBank(bank) === isLicensedBank(found.bank) &&
          bank.name.length < found.bank.name.length);
      if (better) found = { bank, needle: needle.length };
    }
  }
  return found?.bank ?? null;
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
/**
 * Where a share of the payment goes.
 *
 * `amountKobo` is exact, not a percentage. A percentage of a grossed-up total
 * rounds somewhere we cannot see, and the fee engine has already worked out to
 * the kobo who gets what.
 */
export type Split = {
  subAccountCode: string;
  amountKobo: number;
  /** True on the user's share: section 9 says the bearer is always the subaccount. */
  bearsFee: boolean;
};

export async function initTransaction(
  input: {
    amountKobo: number;
    customerName: string;
    customerEmail: string;
    paymentReference: string;
    description: string;
    redirectUrl: string;
    /**
     * The user's share, sent straight to their subaccount.
     *
     * This is the rule the whole product rests on: Balans never holds user
     * money. What is split out settles to the user's own bank on the
     * processor's schedule, and only our fee is left behind in our wallet. A
     * payment without a split would land entirely with us, which is a
     * different business and a licensed one.
     */
    splits?: Split[];
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
        ...(input.splits?.length
          ? {
              incomeSplitConfig: input.splits.map((s) => ({
                subAccountCode: s.subAccountCode,
                // A flat reserved amount rather than splitPercentage: the
                // share is already exact and a percentage would re-round it.
                reservedAmount: s.amountKobo / 100,
                feeBearer: s.bearsFee,
              })),
            }
          : {}),
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

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Monnify's own words for where a transaction stands.
 *
 * Only PAID and OVERPAID mean money arrived. PARTIALLY_PAID is a real state
 * here — a client can pay a bank transfer short — and it is not "paid".
 */
export type PaymentStatus =
  | "PAID"
  | "OVERPAID"
  | "PARTIALLY_PAID"
  | "PENDING"
  | "ABANDONED"
  | "CANCELLED"
  | "FAILED"
  | "REVERSED"
  | "EXPIRED";

export type VerifiedTransaction = {
  transactionReference: string;
  /** Ours, the one we set at initialisation. */
  paymentReference: string;
  paymentStatus: PaymentStatus;
  /** Kobo. Converted here so no caller ever sees a decimal amount. */
  amountPaidKobo: number;
  totalPayableKobo: number;
  /** What actually settles to the subaccount, after the processor's cut. */
  settlementAmountKobo: number | null;
  currency: string;
  paymentMethod: string | null;
  paidOn: string | null;
};

export type VerifyResult =
  | { ok: true; transaction: VerifiedTransaction; raw: unknown }
  | { ok: false; message: string };

/** Monnify returns decimal naira as a number or a string. Both become kobo. */
function toKobo(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  // Round rather than truncate: 49150.00 arriving as 49149.999999 must not
  // quietly lose a kobo.
  return Math.round(n * 100);
}

/**
 * Asks Monnify what really happened (PRD F10).
 *
 * The webhook says a payment succeeded. This is what decides whether it did.
 * A webhook body is something that arrived at our door; this is us going to
 * the provider and asking. Nothing is marked paid on the strength of the
 * former alone, however good its signature.
 */
export async function verifyTransaction(
  transactionReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  // The reference contains pipes ("MNFY|11|..."), which must be encoded or the
  // path is a different path than the one intended.
  const path = `${VERIFY_TRANSACTION_PATH}/${encodeURIComponent(transactionReference)}`;

  const res = await call<{
    transactionReference?: string;
    paymentReference?: string;
    paymentStatus?: string;
    amountPaid?: unknown;
    totalPayable?: unknown;
    settlementAmount?: unknown;
    currencyCode?: string;
    currency?: string;
    paymentMethod?: string;
    paidOn?: string;
  }>(path, { method: "GET" }, fetchImpl);

  if (!res.ok) return { ok: false, message: res.message };

  const b = res.body;
  const amountPaidKobo = toKobo(b.amountPaid);
  const totalPayableKobo = toKobo(b.totalPayable);

  if (!b.paymentReference || !b.paymentStatus || amountPaidKobo === null) {
    return { ok: false, message: "verification response was missing fields" };
  }

  return {
    ok: true,
    raw: b,
    transaction: {
      transactionReference: b.transactionReference ?? transactionReference,
      paymentReference: b.paymentReference,
      paymentStatus: b.paymentStatus as PaymentStatus,
      amountPaidKobo,
      totalPayableKobo: totalPayableKobo ?? amountPaidKobo,
      settlementAmountKobo: toKobo(b.settlementAmount),
      currency: b.currencyCode ?? b.currency ?? "NGN",
      paymentMethod: b.paymentMethod ?? null,
      paidOn: b.paidOn ?? null,
    },
  };
}
