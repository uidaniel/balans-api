import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.MONNIFY_BASE_URL = "https://sandbox.monnify.com";
process.env.MONNIFY_API_KEY = "MK_TEST_KEY";
process.env.MONNIFY_SECRET_KEY = "secret";
process.env.MONNIFY_CONTRACT_CODE = "1234567890";

// A type cannot be pulled out of a destructuring pattern, so it is imported
// separately; the values still come through the dynamic import so the env
// above is set before the module reads it.
import type { Bank } from "./monnify.ts";

const {
  matchBank,
  resolveAccount,
  createSubAccount,
  initTransaction,
  initBankTransfer,
  payoutBlocked,
  resetAuth,
} = await import("./monnify.ts");

/** Responses shaped exactly as the sandbox returned them. */
const envelope = (body: unknown, ok = true) =>
  new Response(
    JSON.stringify({ requestSuccessful: ok, responseMessage: ok ? "success" : "failed", responseBody: body }),
    { status: ok ? 200 : 400 },
  );

const authOk = () => envelope({ accessToken: "tok", expiresIn: 3599 });

/** Answers the login call, then hands everything else to `handler`. */
function stub(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/login")) return authOk();
    return handler(u, init);
  }) as typeof fetch;
}

beforeEach(() => resetAuth());

describe("bank matching, as people actually type it", () => {
  // A slice of the 374 the sandbox returns, including the confusable ones.
  const banks: Bank[] = [
    { name: "Access bank", code: "044", nipBankCode: "044" },
    { name: "Access bank (Diamond)", code: "063", nipBankCode: "063" },
    { name: "GTBank Plc", code: "058", nipBankCode: "058" },
    { name: "United Bank For Africa", code: "033", nipBankCode: "033" },
    { name: "First Bank of Nigeria", code: "011", nipBankCode: "011" },
    { name: "Zenith bank", code: "057", nipBankCode: "057" },
    { name: "Moniepoint MFB", code: "50515", nipBankCode: "50515" },
    { name: "Kuda Microfinance Bank", code: "50211", nipBankCode: "50211" },
    { name: "Sterling bank", code: "232", nipBankCode: "232" },
  ];

  const cases: [string, string | null][] = [
    ["Access bank", "044"],
    ["access", "044"], // must not pick "(Diamond)"
    ["ACCESS BANK", "044"],
    ["gtbank", "058"],
    ["GTB", "058"],
    ["gt bank", "058"],
    ["guaranty trust", "058"],
    ["uba", "033"],
    ["United Bank For Africa", "033"],
    ["first bank", "011"],
    ["fbn", "011"],
    ["zenith", "057"],
    ["moniepoint", "50515"],
    ["kuda", "50211"],
    ["sterling", "232"],
    ["my bank is Zenith,", "057"], // what the machine hands over verbatim
    ["", null],
    ["not a bank at all", null],
  ];

  for (const [input, code] of cases) {
    it(`${JSON.stringify(input)} -> ${code ?? "no match"}`, () => {
      assert.equal(matchBank(input, banks)?.code ?? null, code);
    });
  }
});

describe("resolveAccount", () => {
  it("returns the name the bank gave", async () => {
    const f = stub(() =>
      envelope({
        accountNumber: "1960725673",
        accountName: "DANIEL INIOBONG UWAK",
        bankCode: "044",
        currencyCode: "NGN",
      }),
    );
    const res = await resolveAccount("1960725673", "044", f);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.account.accountName, "DANIEL INIOBONG UWAK");
  });

  it("calls the v2 path, since v1 is deprecated", async () => {
    let seen = "";
    const f = stub((u) => {
      seen = u;
      return envelope({ accountNumber: "1", accountName: "X", bankCode: "044" });
    });
    await resolveAccount("1960725673", "044", f);
    assert.match(seen, /\/api\/v2\/disbursements\/account\/validate\?/);
    assert.match(seen, /accountNumber=1960725673/);
    assert.match(seen, /bankCode=044/);
  });

  it("treats a bad account number as a mistyping, not an outage", async () => {
    const f = stub(
      () =>
        new Response(JSON.stringify({ requestSuccessful: false, responseMessage: "Invalid account details supplied" }), {
          status: 404,
        }),
    );
    const res = await resolveAccount("0000000000", "044", f);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "invalid_details");
  });

  it("treats a 500 as the provider's problem", async () => {
    const f = stub(() => new Response("{}", { status: 500 }));
    const res = await resolveAccount("1960725673", "044", f);
    assert.equal(res.ok === false && res.reason, "provider_error");
  });

  /*
   * Monnify answers 400 both for "no such account" and for "I could not reach
   * that bank", with responseCode 99 either way. Reading the second as the
   * first tells somebody their correct account number is wrong, and they
   * retype a right answer until they give up. Moniepoint users were being put
   * through exactly that.
   */
  it("does not blame the user for a failure that is not theirs", async () => {
    const excuses = [
      "Unable to process request at the moment. Please try again.",
      "Bank is temporarily unavailable",
      "Request timed out",
    ];

    for (const responseMessage of excuses) {
      const f = stub(
        () => new Response(JSON.stringify({ requestSuccessful: false, responseMessage }), { status: 400 }),
      );
      const res = await resolveAccount("8107408438", "50515", f);
      assert.equal(
        res.ok === false && res.reason,
        "provider_error",
        `${JSON.stringify(responseMessage)} is not the user's fault`,
      );
    }
  });

  it("still blames the number when the number really is wrong", async () => {
    // The guard above must not swallow the ordinary mistyping case.
    const f = stub(
      () =>
        new Response(JSON.stringify({ requestSuccessful: false, responseMessage: "Invalid account details supplied" }), {
          status: 400,
        }),
    );
    const res = await resolveAccount("0000000000", "044", f);
    assert.equal(res.ok === false && res.reason, "invalid_details");
  });
});

/*
 * Measured against the sandbox, not assumed: the name check on an OPay or
 * PalmPay account succeeds and the subaccount then fails 500, every time, and
 * Moniepoint fails the name check itself. Saying so up front is the whole
 * point — the alternative is a user confirming their own name and then being
 * told to "try again in a moment", forever.
 */
describe("banks that cannot receive a payout", () => {
  it("names the wallets we know Monnify will not settle into", () => {
    assert.equal(payoutBlocked("305"), "OPay");
    assert.equal(payoutBlocked("999992"), "OPay");
    assert.equal(payoutBlocked("100033"), "PalmPay");
    assert.equal(payoutBlocked("50515"), "Moniepoint");
  });

  it("lets every ordinary bank through", () => {
    for (const code of ["044", "058", "011", "033", "057", "090267"]) {
      assert.equal(payoutBlocked(code), null, `${code} must not be blocked`);
    }
  });

  it("does not care whether the code arrives as a string or a number", () => {
    assert.equal(payoutBlocked(305 as unknown as string), "OPay");
  });
});

describe("createSubAccount", () => {
  it("unwraps the array the endpoint returns", async () => {
    const f = stub(() =>
      envelope([
        {
          subAccountCode: "MFY_SUB_942050897394",
          accountNumber: "1960725673",
          accountName: "DANIEL INIOBONG UWAK",
          currencyCode: "NGN",
          email: "a@b.ng",
          bankCode: "044",
          bankName: "Access bank",
          defaultSplitPercentage: 1,
        },
      ]),
    );
    const res = await createSubAccount({ accountNumber: "1960725673", bankCode: "044", email: "a@b.ng" }, f);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.account.subAccountCode, "MFY_SUB_942050897394");
  });

  it("sends an array, with a split above the minimum", async () => {
    let body: unknown;
    const f = stub((_u, init) => {
      body = JSON.parse(String(init?.body));
      return envelope([{ subAccountCode: "X", accountNumber: "1", accountName: "A", bankCode: "044", bankName: "b", currencyCode: "NGN", email: "e", defaultSplitPercentage: 1 }]);
    });
    await createSubAccount({ accountNumber: "1", bankCode: "044", email: "e" }, f);
    assert.ok(Array.isArray(body));
    // The sandbox rejects anything at or below 0.1.
    assert.ok((body as { defaultSplitPercentage: number }[])[0]!.defaultSplitPercentage > 0.1);
  });

  it("reuses the existing subaccount when Monnify says it already exists", async () => {
    // Re-running setup, or an earlier attempt that got this far, must not be a
    // dead end: the subaccount that exists is the right answer.
    const existing = {
      subAccountCode: "MFY_SUB_942050897394",
      accountNumber: "1960725673",
      accountName: "DANIEL INIOBONG UWAK",
      bankCode: "044",
      bankName: "Access bank",
      currencyCode: "NGN",
      email: "a@b.ng",
      defaultSplitPercentage: 1,
    };

    const f = stub((u, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            requestSuccessful: false,
            responseMessage: "Sub account with account number 1960725673 already exists for merchant.",
          }),
          { status: 400 },
        );
      }
      return envelope([existing]); // The GET listing.
    });

    const res = await createSubAccount({ accountNumber: "1960725673", bankCode: "044", email: "a@b.ng" }, f);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.account.subAccountCode, "MFY_SUB_942050897394");
    assert.equal(res.ok && res.reused, true);
  });

  it("still fails if it already exists but cannot be found", async () => {
    const f = stub((_u, init) =>
      init?.method === "POST"
        ? new Response(
            JSON.stringify({ requestSuccessful: false, responseMessage: "already exists for merchant." }),
            { status: 400 },
          )
        : envelope([]),
    );
    const res = await createSubAccount({ accountNumber: "1960725673", bankCode: "044", email: "a@b.ng" }, f);
    assert.equal(res.ok, false);
  });

  it("fails cleanly on an empty array", async () => {
    const f = stub(() => envelope([]));
    const res = await createSubAccount({ accountNumber: "1", bankCode: "044", email: "e" }, f);
    assert.equal(res.ok, false);
  });
});

describe("initTransaction", () => {
  it("converts kobo to naira exactly once", async () => {
    let body: Record<string, unknown> = {};
    const f = stub((_u, init) => {
      body = JSON.parse(String(init?.body));
      return envelope({ transactionReference: "MNFY|1", checkoutUrl: "https://checkout/x" });
    });

    await initTransaction(
      {
        amountKobo: 350_000_00,
        customerName: "Zenith Homes",
        customerEmail: "z@h.ng",
        paymentReference: "inv-14",
        description: "Invoice 14",
        redirectUrl: "https://balans.ng/pay/callback",
      },
      f,
    );

    // 35_000_000 kobo is 350,000 naira. Getting this wrong by 100x is the
    // single most expensive bug available in this codebase.
    assert.equal(body.amount, 350_000);
    assert.equal(body.currencyCode, "NGN");
    assert.equal(body.contractCode, "1234567890");
  });

  it("returns the checkout url", async () => {
    const f = stub(() => envelope({ transactionReference: "MNFY|1", checkoutUrl: "https://checkout/x" }));
    const res = await initTransaction(
      { amountKobo: 1000_00, customerName: "A", customerEmail: "a@b.ng", paymentReference: "r", description: "d", redirectUrl: "u" },
      f,
    );
    assert.equal(res.ok && res.checkoutUrl, "https://checkout/x");
  });

  /*
   * We collect by transfer on our own page now, so a missing checkoutUrl is no
   * longer a failure. A missing transactionReference still is: it is what the
   * transfer account is issued against, and what the webhook is reconciled by.
   */
  it("carries on without a checkout url, which we no longer use", async () => {
    const f = stub(() => envelope({ transactionReference: "MNFY|1" }));
    const res = await initTransaction(
      { amountKobo: 1000_00, customerName: "A", customerEmail: "a@b.ng", paymentReference: "r", description: "d", redirectUrl: "u" },
      f,
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.transactionReference, "MNFY|1");
  });

  it("fails when no transaction reference comes back", async () => {
    const f = stub(() => envelope({ checkoutUrl: "https://checkout/x" }));
    const res = await initTransaction(
      { amountKobo: 1000_00, customerName: "A", customerEmail: "a@b.ng", paymentReference: "r", description: "d", redirectUrl: "u" },
      f,
    );
    assert.equal(res.ok, false);
  });
});

/*
 * Pay by transfer. The shape below is exactly what the sandbox returned on
 * 21 September 2026, down to the zoneless `expiresOn`, which is the field
 * this code deliberately does not trust.
 */
describe("initBankTransfer", () => {
  const sandbox = {
    accountNumber: "7004199814",
    accountName: "Balans-Pro",
    bankName: "Sterling bank",
    bankCode: "232",
    accountDurationSeconds: 2400,
    ussdPayment: null,
    requestTime: "2026-09-21T23:07:43.900657213",
    expiresOn: "2026-09-21T23:47:43",
    transactionReference: "MNFY|57|20260921230742|000016",
    paymentReference: "probe_1",
    amount: 2000.0,
    fee: 0.0,
    totalPayable: 2000.0,
    collectionChannel: "API_NOTIFICATION",
  };

  it("reads the account the payer must send to", async () => {
    const f = stub(() => envelope(sandbox));
    const res = await initBankTransfer("MNFY|57", f);

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.account.accountNumber, "7004199814");
    assert.equal(res.account.bankName, "Sterling bank");
    assert.equal(res.account.accountName, "Balans-Pro");
    // Naira in, kobo out: the page must never render a float.
    assert.equal(res.account.totalPayableKobo, 200000);
  });

  it("posts the transaction reference it was given", async () => {
    let sent: unknown;
    const f = stub((_u, init) => {
      sent = JSON.parse(String(init?.body));
      return envelope(sandbox);
    });
    await initBankTransfer("MNFY|57|x", f);
    assert.deepEqual(sent, { transactionReference: "MNFY|57|x" });
  });

  /*
   * The expiry drives a countdown and, more importantly, whether we reuse an
   * account. `expiresOn` has no zone on it; read as UTC on a UTC server it is
   * an hour of Lagos time out, in the direction that keeps a dead account on
   * screen. So the duration wins whenever it is there.
   */
  it("takes the expiry from the duration, not their zoneless timestamp", async () => {
    const f = stub(() => envelope(sandbox));
    const before = Date.now();
    const res = await initBankTransfer("MNFY|57", f);
    assert.equal(res.ok, true);
    if (!res.ok) return;

    const ms = res.account.expiresAt.getTime() - before;
    assert.ok(ms > 2_390_000 && ms < 2_410_000, `expected ~2400s, got ${Math.round(ms / 1000)}s`);
  });

  it("reads their timestamp as Lagos time when there is no duration", async () => {
    const f = stub(() => envelope({ ...sandbox, accountDurationSeconds: undefined }));
    const res = await initBankTransfer("MNFY|57", f);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 23:47:43 in Lagos is 22:47:43 UTC.
    assert.equal(res.account.expiresAt.toISOString(), "2026-09-21T22:47:43.000Z");
  });

  it("expires almost immediately rather than trusting a date it cannot read", async () => {
    const f = stub(() => envelope({ ...sandbox, accountDurationSeconds: 0, expiresOn: "not a date" }));
    const res = await initBankTransfer("MNFY|57", f);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const ms = res.account.expiresAt.getTime() - Date.now();
    assert.ok(ms > 0 && ms <= 5 * 60 * 1000, `expected a short fallback, got ${ms}ms`);
  });

  it("refuses a response with no account on it", async () => {
    const f = stub(() => envelope({ bankName: "Sterling bank", totalPayable: 2000.0 }));
    const res = await initBankTransfer("MNFY|57", f);
    assert.equal(res.ok, false);
  });

  it("passes the provider's message through when it refuses", async () => {
    const f = stub(
      () =>
        new Response(
          JSON.stringify({ requestSuccessful: false, responseMessage: "Transaction not found" }),
          { status: 404 },
        ),
    );
    const res = await initBankTransfer("MNFY|nope", f);
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.message : "", /Transaction not found/);
  });
});

describe("auth", () => {
  it("authenticates once and reuses the token", async () => {
    let logins = 0;
    const f = (async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/auth/login")) {
        logins++;
        return authOk();
      }
      return envelope([]);
    }) as typeof fetch;

    await createSubAccount({ accountNumber: "1", bankCode: "044", email: "e" }, f);
    await createSubAccount({ accountNumber: "2", bankCode: "044", email: "e" }, f);
    assert.equal(logins, 1, "the token should be cached between calls");
  });

  it("throws a clear error when credentials are refused", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ requestSuccessful: false, responseMessage: "Invalid credentials" }), {
        status: 401,
      })) as typeof fetch;
    await assert.rejects(() => resolveAccount("1", "044", f), /Monnify auth failed/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a bank name resolves to a bank that can be paid", () => {
  /**
   * Monnify lists 374 entries, and only 85 have a three-digit CBN code. The
   * rest are NIP-only routes: wallets, agent networks, some microfinance
   * banks. Both kinds resolve an account name perfectly well, which is the
   * trap — a wallet passes every check and then fails at subaccount creation,
   * after the user has confirmed their name and thinks they are finished.
   *
   * Several institutions appear twice, once each way. These are the ones that
   * must land on the bank.
   */
  const LIST: Bank[] = [
    { name: "GTBank", code: "058", nipBankCode: "058" },
    { name: "GT MOBILE", code: "923", nipBankCode: "923" },
    { name: "Access bank", code: "044", nipBankCode: "044" },
    { name: "ACCESS MONEY", code: "927", nipBankCode: "927" },
    { name: "ACCESS YELLO & BETA", code: "100052", nipBankCode: "100052" },
    { name: "Zenith bank", code: "057", nipBankCode: "057" },
    { name: "ZENITH MOBILE", code: "932", nipBankCode: "932" },
    { name: "United Bank For Africa Plc", code: "033", nipBankCode: "033" },
    { name: "First City Monument Bank Plc", code: "214", nipBankCode: "214" },
    { name: "FCMB MOBILE", code: "100031", nipBankCode: "100031" },
    { name: "OPAY 3", code: "999992", nipBankCode: "999992" },
    { name: "PAYCOM (OPAY)", code: "305", nipBankCode: "100004" },
    { name: "Globus", code: "00103", nipBankCode: "00103" },
    { name: "Globus Bank", code: "103", nipBankCode: "103" },
    { name: "Wema bank", code: "035", nipBankCode: "035" },
    { name: "Moniepoint Microfinance Bank", code: "50515", nipBankCode: "50515" },
  ];

  const cases: [string, string][] = [
    ["gtbank", "058"],
    ["gtb", "058"],
    ["guaranty trust", "058"],
    ["access", "044"],
    ["access bank", "044"],
    ["zenith", "057"],
    ["uba", "033"],
    // The abbreviation everybody uses matched only the wallet before.
    ["fcmb", "214"],
    ["first city monument", "214"],
    // Same institution listed twice; only one of them settles.
    ["opay", "305"],
    // An exact name match on a NIP route must not beat the licensed bank.
    ["globus", "103"],
    ["wema", "035"],
    // A bank name inside a sentence, which is how the machine hands it over.
    ["my bank is Zenith,", "057"],
    ["i use gtb", "058"],
  ];

  for (const [query, code] of cases) {
    it(`${JSON.stringify(query)} -> ${code}`, () => {
      assert.equal(matchBank(query, LIST)?.code, code);
    });
  }

  it("still finds a bank that only exists as a NIP route", () => {
    // Preferring licensed banks must not mean refusing the others. Moniepoint
    // has no CBN entry, and plenty of freelancers are paid there.
    assert.equal(matchBank("moniepoint", LIST)?.code, "50515");
  });

  it("returns nothing rather than guessing", () => {
    assert.equal(matchBank("not a bank at all", LIST), null);
    assert.equal(matchBank("", LIST), null);
  });
});
