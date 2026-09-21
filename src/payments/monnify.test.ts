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

const { matchBank, resolveAccount, createSubAccount, initTransaction, resetAuth } =
  await import("./monnify.ts");

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

  it("fails when no checkout url comes back", async () => {
    const f = stub(() => envelope({ transactionReference: "MNFY|1" }));
    const res = await initTransaction(
      { amountKobo: 1000_00, customerName: "A", customerEmail: "a@b.ng", paymentReference: "r", description: "d", redirectUrl: "u" },
      f,
    );
    assert.equal(res.ok, false);
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
