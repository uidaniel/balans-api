/**
 * Paystack client, for invoices priced abroad (International PRD section 8).
 *
 * A second processor, not a replacement. Naira invoices go to Monnify and
 * always will — bank transfer into a reserved account, split at the moment
 * the money moves. Paystack is here for one reason: it charges international
 * cards, which Monnify does not do at all.
 *
 * And it charges them *in naira*. The client's card is debited in naira, the
 * client's own bank does the conversion, and what reaches the subaccount is
 * naira. So every transaction below is an ordinary NGN one and the dollars
 * exist only on the document. That is section 2's conclusion and it is why
 * nothing here takes a currency other than NGN.
 *
 * Rule 1 of the platform PRD applies unchanged: Balans never holds user
 * money. The user's share is split to their own Paystack subaccount at the
 * moment of payment, and nothing here moves funds out of a Balans balance,
 * because there is never anything in one.
 *
 * WHAT WAS PROVED AGAINST THE SANDBOX, 24 September 2026, rather than read in
 * the documentation. Each is recorded beside the call it belongs to:
 *
 *   - a subaccount needs `settlement_bank` and `account_number`, and in test
 *     mode only 057 + 0000000000 is accepted; 011 and 058 are refused with
 *     "Account details are invalid";
 *   - `percentage_charge: 0` is accepted, which Pro needs;
 *   - `bearer: "subaccount"` does stick, but it is *not* echoed as a
 *     top-level field. It comes back under `fees_split.params.bearer`, which
 *     is the only place anything can confirm it;
 *   - test mode allows three live bank resolves a day and then refuses with a
 *     429 telling you to use bank code 001;
 *   - unknown fields are silently dropped, exactly like Monnify. So no field
 *     here is believed to work because it was accepted — only a rejection, or
 *     an echo, proves anything.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { env, require_ } from "../config.ts";

const SUBACCOUNT_PATH = "/subaccount";
const INITIALIZE_PATH = "/transaction/initialize";
const VERIFY_PATH = "/transaction/verify";
const CHARGE_PATH = "/charge";

type Envelope<T> = {
  status?: boolean;
  message?: string;
  data?: T;
};

const base = (): string => env.PAYSTACK_BASE_URL.replace(/\/+$/, "");

/**
 * No auth call, unlike Monnify.
 *
 * The secret key is the bearer token. There is no token to cache, nothing to
 * refresh, and no window in which a request can fail because a token expired
 * mid-flight — which removes the whole class of problem the Monnify client
 * has a cache and a one-minute safety margin for.
 */
async function call<T>(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: T } | { ok: false; status: number; message: string }> {
  require_("PAYSTACK_SECRET_KEY");

  const res = await fetchImpl(`${base()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.json().catch(() => ({}))) as Envelope<T>;

  if (res.ok && body.status === true && body.data !== undefined) {
    return { ok: true, body: body.data };
  }
  return { ok: false, status: res.status, message: body.message ?? `HTTP ${res.status}` };
}

/* -------------------------------------------------------------------------- */
/* Subaccounts                                                                */
/* -------------------------------------------------------------------------- */

export type PaystackSubAccount = {
  subaccountCode: string;
  accountNumber: string;
  accountName: string | null;
  /**
   * [Sandbox] What Paystack echoes here is the bank's *name* ("Zenith Bank"),
   * not the code that was sent. Kept as it comes rather than corrected, since
   * the code we sent is already on the user's bank account row.
   */
  settlementBank: string;
  currency: string;
};

export type CreateSubAccountResult =
  | { ok: true; account: PaystackSubAccount; reused?: boolean }
  | {
      ok: false;
      message: string;
      /**
       * Whether sending the same details again could ever work. A 5xx is the
       * provider failing; a 4xx is a judgement about these details, and
       * repeating them is how somebody sends their account number six times
       * to the same refusal.
       */
      retryable: boolean;
    };

/**
 * The subaccount a user's international share settles into.
 *
 * Created the first time a Pro user invoices abroad, from the bank details
 * they already gave us — not asked for again. They have one bank account and
 * may now have two references to it: Monnify's, which every naira invoice
 * splits through, and this one.
 *
 * `percentage_charge` is zero and that is the whole commercial arrangement on
 * this path: international invoicing is Pro, Pro carries no Balans fee, so
 * the subaccount keeps everything Paystack does not take. It is not a default
 * to be overridden per transaction the way Monnify's is — it is the answer.
 *
 * [Sandbox] Zero is accepted. Paystack's documentation implies a positive
 * share and does not say what happens at zero; it creates the subaccount and
 * `fees_split.params.percentage_charge` comes back "0".
 */
export async function createSubAccount(
  input: {
    businessName: string;
    accountNumber: string;
    /** Paystack's own bank code, from `GET /bank`. Not a NIP code. */
    bankCode: string;
    email: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CreateSubAccountResult> {
  const res = await call<{
    subaccount_code?: string;
    account_number?: string;
    account_name?: string | null;
    settlement_bank?: string;
    currency?: string;
  }>(
    SUBACCOUNT_PATH,
    {
      method: "POST",
      body: JSON.stringify({
        business_name: input.businessName,
        settlement_bank: input.bankCode,
        account_number: input.accountNumber,
        percentage_charge: 0,
        primary_contact_email: input.email,
      }),
    },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message, retryable: res.status >= 500 };

  const code = res.body.subaccount_code;
  if (!code) return { ok: false, message: "no subaccount returned", retryable: true };

  return {
    ok: true,
    account: {
      subaccountCode: code,
      accountNumber: res.body.account_number ?? input.accountNumber,
      accountName: res.body.account_name ?? null,
      settlementBank: res.body.settlement_bank ?? input.bankCode,
      currency: res.body.currency ?? "NGN",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Banks                                                                      */
/* -------------------------------------------------------------------------- */

export type PaystackBank = { name: string; code: string };

/**
 * Paystack's bank list, which is not Monnify's.
 *
 * The codes differ, and a code from one used with the other is either refused
 * or — worse — accepted as a different bank. The user's stored `bank_code` is
 * Monnify's, so it has to be translated by name before a subaccount is made,
 * which is what `matchByName` is for.
 */
export async function listBanks(fetchImpl: typeof fetch = fetch): Promise<PaystackBank[]> {
  const res = await call<{ name?: string; code?: string }[]>(
    // All of them. At 100 a page the list stopped at "L", and 187 banks —
    // Moniepoint, OPay, PalmPay among them — could not be found at all.
    `/bank?country=nigeria&currency=NGN&perPage=500`,
    { method: "GET" },
    fetchImpl,
  );
  if (!res.ok) return [];
  return res.body
    .filter((b): b is { name: string; code: string } => Boolean(b.name && b.code))
    .map((b) => ({ name: b.name, code: b.code }));
}

/**
 * The same list, held for an hour.
 *
 * The public invoice page asks whether a card can be taken *before* drawing
 * the Pay button, so this is now on the path of a page a stranger loads rather
 * than only on the path of a payment. Nigeria's bank list changes a few times
 * a year; fetching it per page view would be a call to Paystack every time
 * somebody looks at an invoice.
 *
 * A failed fetch is not cached. `listBanks` answers `[]` rather than throwing,
 * and an empty list would otherwise mean an hour of telling every client that
 * card payment is unavailable because of one bad minute.
 *
 * Separate from `listBanks` rather than folded into it, because the tests for
 * that one drive it with their own `fetch` and a shared cache would leak
 * between them.
 */
const BANKS_TTL_MS = 60 * 60 * 1000;
let banksCache: { at: number; banks: PaystackBank[] } | null = null;

export async function cachedBanks(): Promise<PaystackBank[]> {
  if (banksCache && Date.now() - banksCache.at < BANKS_TTL_MS) return banksCache.banks;
  const banks = await listBanks();
  if (banks.length > 0) banksCache = { at: Date.now(), banks };
  return banks;
}

/** Normalised for comparison: case, punctuation and the word "bank" removed. */
const key = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\bplc\b|\blimited\b|\bltd\b|\bbank\b/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * The same institution, under the name each provider happens to use.
 *
 * Normalising case and punctuation is not enough, because the two lists
 * genuinely disagree about what these banks are called: we store Monnify's
 * "GTBank" and Paystack lists "Guaranty Trust Bank". No amount of string
 * tidying turns one into the other, so every GTBank user — one of the largest
 * banks in the country — was told card payment was unavailable, for ever.
 *
 * Every row here was checked against both live lists on 24 Sep 2026, and the
 * check is that *the two providers' codes agree*: Monnify's "GTBank" is 058
 * and Paystack's "Guaranty Trust Bank" is 058. That agreement is independent
 * corroboration that it is one institution, which is what makes this a
 * verified table rather than a list of guesses.
 *
 * Where the codes disagree there is no row, however alike the names look, and
 * Coronation is why. Monnify lists "Coronation Bank" at 946; Paystack's 946 is
 * **Money Master PSB**, an entirely different company, while its Coronation is
 * 559. A row written from the names alone would have settled somebody's card
 * payments into a stranger's institution — the exact failure this whole module
 * is built to refuse.
 *
 * Names, not codes, because the live list stays the authority on the code: if
 * Paystack renumbers, we follow it rather than carrying a stale number here.
 */
const ALIASES = new Map(
  (
    [
      // Monnify's name              Paystack's name          Shared code
      ["GTBank", "Guaranty Trust Bank"], //                    058
      ["First bank", "First Bank of Nigeria"], //              011
      ["Union bank", "Union Bank of Nigeria"], //              032
      ["Diamond bank", "Access Bank (Diamond)"], //            063
      ["Standard Chartered Bank Nigeria Ltd.", "Standard Chartered Bank"], // 068
      ["Suntrust Bank Nigeria Limited", "Suntrust Bank"], //   100
      ["Rubies Micro-finance Bank", "Rubies MFB"], //          125
      ["Parkway Projects", "Parkway - ReadyCash"], //          311
    ] as const
  ).map(([from, to]) => [key(from), key(to)] as const),
);

/**
 * The Paystack code for a bank we know by name.
 *
 * By name rather than by code, because the two providers' codes are different
 * namespaces and there is no mapping between them. An exact normalised match
 * only: a bank picked by fuzzy resemblance is somebody's money sent to a
 * different institution, and returning null costs a support message instead.
 *
 * The alias table above is checked first, and it is exact too — a hand-checked
 * pair of names, never a resemblance. A bank in neither still returns null.
 */
export function matchByName(bankName: string, banks: PaystackBank[]): PaystackBank | null {
  const k = key(bankName);
  if (!k) return null;
  const want = ALIASES.get(k) ?? k;
  return banks.find((b) => key(b.name) === want) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Taking a payment                                                           */
/* -------------------------------------------------------------------------- */

export type InitResult =
  | { ok: true; authorizationUrl: string; accessCode: string; reference: string }
  | { ok: false; message: string; retryable: boolean };

/**
 * Starts a card payment and returns the page to send the client to.
 *
 * Every field here is load-bearing and section 8 names each one:
 *
 *   `currency: "NGN"` — the card is charged in naira whatever the invoice is
 *   priced in, because that is the only arrangement that settles to a
 *   Nigerian bank account (section 2).
 *
 *   `bearer: "subaccount"` — without it Paystack takes its fee from the main
 *   account, which is ours. That would mean Balans paying the processing cost
 *   of somebody else's invoice, silently, on every international payment.
 *   [Sandbox] It is accepted and stuck, but it is not echoed as a field: the
 *   only confirmation is `fees_split.params.bearer` on the verify response,
 *   which is what `verifyTransaction` reads it out of.
 *
 *   `transaction_charge: 0` — Balans takes nothing. Pro carries no fee and
 *   international invoicing is Pro only.
 *
 *   `channels: ["card"]` — v1 is cards. Offering bank transfer to a client
 *   abroad offers something their bank cannot do.
 */
export async function initTransaction(
  input: {
    email: string;
    /** The naira charge, in kobo. Never the foreign amount. */
    amountKobo: number;
    reference: string;
    subaccountCode: string;
    callbackUrl: string;
    /** Carried through the whole payment and returned on verify. */
    metadata: Record<string, unknown>;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<InitResult> {
  const res = await call<{
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  }>(
    INITIALIZE_PATH,
    {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: input.amountKobo,
        currency: "NGN",
        reference: input.reference,
        subaccount: input.subaccountCode,
        bearer: "subaccount",
        transaction_charge: 0,
        channels: ["card"],
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message, retryable: res.status >= 500 };

  const url = res.body.authorization_url;
  if (!url) return { ok: false, message: "no authorization url returned", retryable: true };

  return {
    ok: true,
    authorizationUrl: url,
    accessCode: res.body.access_code ?? "",
    reference: res.body.reference ?? input.reference,
  };
}

/* -------------------------------------------------------------------------- */
/* Whose account is this                                                      */
/* -------------------------------------------------------------------------- */

export type AccountCheck =
  | { ok: true; account: { accountNumber: string; accountName: string; bankCode: string } }
  | { ok: false; reason: "invalid_details" | "provider_error"; message: string };

/**
 * Asks the bank, through Paystack, whose account this is.
 *
 * The name that comes back is what the user confirms and what every invoice
 * prints, so it is never taken from the user. A 422 "Could not resolve
 * account name" is somebody's typo; anything else — a bank that did not
 * answer, a test key over its daily allowance — is ours, and the caller may
 * ask somebody else before blaming the user for it.
 */
export async function resolveAccountNumber(
  accountNumber: string,
  bankCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountCheck> {
  const q = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
  const res = await call<{ account_number?: string; account_name?: string }>(
    `/bank/resolve?${q}`,
    { method: "GET" },
    fetchImpl,
  );
  if (res.ok && res.body.account_name) {
    return {
      ok: true,
      account: { accountNumber: res.body.account_number ?? accountNumber, accountName: res.body.account_name, bankCode },
    };
  }
  if (!res.ok && res.status === 422 && /could not resolve|invalid|not found/i.test(res.message)) {
    return { ok: false, reason: "invalid_details", message: res.message };
  }
  return { ok: false, reason: "provider_error", message: res.ok ? "no account name returned" : res.message };
}

/* -------------------------------------------------------------------------- */
/* Paying us by transfer                                                      */
/* -------------------------------------------------------------------------- */

export type TransferAccount = {
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** When the account stops taking this payment. */
  expiresAt: Date;
  reference: string;
};

export type TransferResult =
  | { ok: true; account: TransferAccount }
  | { ok: false; message: string; retryable: boolean };

/**
 * An account number to pay Pro into, made for this one payment.
 *
 * Paystack's "Pay with Transfer" through the Charge API: it opens a
 * temporary account for the exact amount, and a transfer to it arrives as an
 * ordinary `charge.success` on the webhook, under the reference we chose —
 * which is the same `sub_` reference `confirmSubscription` already knows how
 * to turn into a month of Pro.
 *
 * Replaces the Monnify checkout for Pro. Nearly everybody here pays by
 * transfer anyway, and a checkout page was a detour to reach an account
 * number; this is the account number.
 *
 * Needs "Pay with Transfer" switched on for the Paystack business. Until it
 * is, Paystack refuses the charge and the caller says so rather than failing
 * quietly.
 */
export async function chargeByTransfer(
  input: {
    email: string;
    amountKobo: number;
    reference: string;
    expiresAt: Date;
    metadata: Record<string, unknown>;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TransferResult> {
  const res = await call<{
    reference?: string;
    account_number?: string;
    account_name?: string;
    account_expires_at?: string;
    bank?: { name?: string };
  }>(
    CHARGE_PATH,
    {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: input.amountKobo,
        reference: input.reference,
        bank_transfer: { account_expires_at: input.expiresAt.toISOString() },
        metadata: input.metadata,
      }),
    },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message, retryable: res.status >= 500 };

  const b = res.body;
  if (!b.account_number) {
    return { ok: false, message: "no account number returned", retryable: true };
  }
  return {
    ok: true,
    account: {
      bankName: b.bank?.name ?? "Paystack",
      accountNumber: b.account_number,
      accountName: b.account_name ?? "Balans",
      expiresAt: b.account_expires_at ? new Date(b.account_expires_at) : input.expiresAt,
      reference: b.reference ?? input.reference,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Finding out what actually happened                                         */
/* -------------------------------------------------------------------------- */

export type PaymentStatus = "success" | "failed" | "abandoned" | "pending" | "reversed" | "unknown";

export type VerifiedTransaction = {
  reference: string;
  status: PaymentStatus;
  /** What was actually charged, in kobo. Compared against what we asked for. */
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
  channel: string | null;
  /**
   * What Paystack took, in kobo.
   *
   * [Sandbox] Not predictable from the request. `fees` was null on an
   * unpaid transaction and the split showed ₦2,000 — the *local* card cap,
   * not the 3.9% international rate, because Paystack cannot know where the
   * card is from until it is used. So the figure Balans shows the freelancer
   * on the draft is an estimate from configuration, and this is the truth.
   * Section 13's go-live gate is the reconciliation of the two.
   */
  feeKobo: number | null;
  /** Who bore the fee, read out of `fees_split.params`. See `initTransaction`. */
  bearer: string | null;
  subaccountCode: string | null;
  /** ISO country of the issuing card, where Paystack reports one. */
  cardCountry: string | null;
  /** Null when there is nothing to judge it by, rather than a guessed false. */
  internationalCard: boolean | null;
  metadata: Record<string, unknown> | null;
  /** The whole response, stored for reconciliation. */
  raw: unknown;
};

export type VerifyResult =
  | { ok: true; transaction: VerifiedTransaction }
  | { ok: false; message: string; retryable: boolean };

const STATUSES: Record<string, PaymentStatus> = {
  success: "success",
  failed: "failed",
  abandoned: "abandoned",
  pending: "pending",
  ongoing: "pending",
  processing: "pending",
  queued: "pending",
  reversed: "reversed",
};

/**
 * What Paystack says happened, asked of Paystack.
 *
 * A webhook proves who sent it, not what happened — so nothing is ever marked
 * paid on the strength of a signed body alone. Section 8: verify by API,
 * check the amount and the currency, and anything that disagrees becomes
 * `needs_review` rather than a payment.
 */
export async function verifyTransaction(
  reference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const res = await call<Record<string, unknown>>(
    `${VERIFY_PATH}/${encodeURIComponent(reference)}`,
    { method: "GET" },
    fetchImpl,
  );

  if (!res.ok) return { ok: false, message: res.message, retryable: res.status >= 500 };

  const d = res.body;
  const auth = (d.authorization ?? {}) as Record<string, unknown>;
  const split = (d.fees_split ?? null) as { params?: Record<string, unknown> } | null;

  const country = typeof auth.country_code === "string" ? auth.country_code : null;
  const paidAt = typeof d.paid_at === "string" ? new Date(d.paid_at) : null;

  return {
    ok: true,
    transaction: {
      reference: typeof d.reference === "string" ? d.reference : reference,
      status: STATUSES[String(d.status)] ?? "unknown",
      amountKobo: typeof d.amount === "number" ? d.amount : 0,
      currency: typeof d.currency === "string" ? d.currency : "NGN",
      paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
      channel: typeof d.channel === "string" ? d.channel : null,
      feeKobo: typeof d.fees === "number" ? d.fees : null,
      bearer: typeof split?.params?.bearer === "string" ? split.params.bearer : null,
      subaccountCode:
        typeof (d.subaccount as { subaccount_code?: unknown } | undefined)?.subaccount_code ===
        "string"
          ? ((d.subaccount as { subaccount_code: string }).subaccount_code)
          : null,
      cardCountry: country,
      /*
       * A Nigerian card paying an international invoice is still a valid
       * payment, and section 8 says to treat it as paid — it is simply an
       * ordinary naira payment. This records which it was, because the fee
       * and the chargeback risk are not the same for the two, and null means
       * Paystack told us nothing rather than that it was local.
       */
      internationalCard: country === null ? null : country.toUpperCase() !== "NG",
      metadata: (d.metadata ?? null) as Record<string, unknown> | null,
      raw: d,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a webhook body really came from Paystack.
 *
 * HMAC SHA512 of the *raw* body with the secret key, compared against
 * `x-paystack-signature`. Raw, byte for byte: a body that has been parsed and
 * re-serialised is a different string with the same meaning, and it produces
 * a different digest, so the route has to keep the bytes it received.
 *
 * Compared in constant time. A byte-by-byte comparison that returns early
 * leaks how much of a guess was right, which is enough to find the rest one
 * character at a time.
 *
 * This proves the sender and nothing else. What happened is still asked of
 * `verifyTransaction`.
 */
export function verifySignature(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  require_("PAYSTACK_SECRET_KEY");

  const expected = createHmac("sha512", env.PAYSTACK_SECRET_KEY!)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a length
  // leak — but the digest length is fixed and public, so there is nothing
  // here an attacker does not already know.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether Paystack is configured at all. Absent keys mean no foreign invoices. */
export const paystackConfigured = (): boolean => Boolean(env.PAYSTACK_SECRET_KEY);
