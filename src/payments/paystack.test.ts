/**
 * The Paystack client, tested against what the sandbox actually returned.
 *
 * Every fixture below is a real response, trimmed. That matters more here
 * than usual: unknown fields are silently dropped by this API, exactly as
 * they are by Monnify, so a request that is accepted proves nothing about
 * whether it did what we meant. What proves it is the shape that comes back,
 * and these are those shapes.
 *
 * The one that would otherwise go unnoticed is the bearer. `bearer:
 * "subaccount"` is what stops Paystack taking its fee out of the *main*
 * account — ours — on every international payment somebody else's client
 * makes. It is accepted silently either way, and it is not echoed as a field.
 * The only confirmation anywhere is `fees_split.params.bearer`, so that is
 * what `verifyTransaction` reads and what these tests hold it to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

/*
 * The key is set before the client is loaded, which is why the import below
 * is a dynamic one.
 *
 * `config.ts` parses the environment once, at import, into a frozen object —
 * deliberately, so a misconfigured deployment fails at boot rather than at
 * the first request. Setting the variable inside a `before()` hook therefore
 * changes nothing, and every test here fails on a missing key while looking
 * like a bug in the client. Node runs each test file in its own process, so
 * this is confined to this one.
 */
const KEY = "sk_test_0000000000000000000000000000000000000000";
process.env.PAYSTACK_SECRET_KEY = KEY;

const {
  createSubAccount,
  initTransaction,
  listBanks,
  matchByName,
  verifySignature,
  verifyTransaction,
} = await import("./paystack.ts");

/** A fetch that answers with one body, and records what it was asked. */
function answering(body: unknown, status = 200) {
  const seen: { url: string; init: RequestInit; sent: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({
      url,
      init,
      sent: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("proving a webhook came from Paystack", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "bal_x" } });
  const signed = (s: string, key = KEY) => createHmac("sha512", key).update(s).digest("hex");


  it("accepts a body signed with our key", () => {
    assert.equal(verifySignature(body, signed(body)), true);
  });

  it("refuses a body that changed by one space", () => {
    /*
     * Which is why the route must keep the bytes it received. A body that has
     * been parsed and re-serialised is a different string with the same
     * meaning, and it produces a different digest — so a signature check run
     * against `JSON.stringify(req.body)` passes or fails on whether the
     * sender's formatting happened to match ours.
     */
    assert.equal(verifySignature(`${body} `, signed(body)), false);
    assert.equal(verifySignature(body.replace("bal_x", "bal_y"), signed(body)), false);
  });

  it("refuses one signed with a different key", () => {
    assert.equal(verifySignature(body, signed(body, "sk_test_someone_else")), false);
  });

  it("refuses a missing or wrong-length signature", () => {
    assert.equal(verifySignature(body, undefined), false);
    assert.equal(verifySignature(body, ""), false);
    assert.equal(verifySignature(body, "deadbeef"), false);
  });

  it("reads the raw bytes, not a decoded string", () => {
    // The route hands over a Buffer. Both must give the same answer, because
    // one of them is what production actually passes.
    const raw = Buffer.from(body, "utf8");
    assert.equal(verifySignature(raw, signed(body)), true);
  });
});

describe("creating the subaccount a user's share settles into", () => {

  /** The real 201, trimmed. */
  const created = {
    status: true,
    message: "Subaccount created",
    data: {
      subaccount_code: "ACCT_yxs6g56bmt5ykjq",
      account_number: "0000000000",
      account_name: "Test",
      settlement_bank: "Zenith Bank",
      currency: "NGN",
      percentage_charge: 0,
    },
  };

  it("asks for nothing of Balans's share", () => {
    /*
     * The entire commercial arrangement on this path, in one field.
     * International invoicing is Pro, Pro carries no Balans fee, so the
     * subaccount keeps everything Paystack does not take. Anything above zero
     * here would be a charge nobody agreed to, taken from every international
     * payment for as long as the subaccount exists.
     */
    const { fetchImpl, seen } = answering(created, 201);
    return createSubAccount(
      { businessName: "Probe Studio", accountNumber: "0000000000", bankCode: "057", email: "a@b.ng" },
      fetchImpl,
    ).then(() => {
      assert.equal(seen[0]!.sent.percentage_charge, 0);
      assert.equal(seen[0]!.sent.settlement_bank, "057");
      assert.equal(seen[0]!.sent.account_number, "0000000000");
    });
  });

  it("returns the code everything else hangs off", async () => {
    const { fetchImpl } = answering(created, 201);
    const r = await createSubAccount(
      { businessName: "Probe", accountNumber: "0000000000", bankCode: "057", email: "a@b.ng" },
      fetchImpl,
    );
    assert.ok(r.ok);
    assert.equal(r.account.subaccountCode, "ACCT_yxs6g56bmt5ykjq");
  });

  it("says whether sending the same details again could ever work", async () => {
    /*
     * The real refusal, word for word: bank 011 and 058 with the test account
     * number both come back like this. It is a judgement about these details,
     * so repeating them is how somebody sends their account number six times
     * to the same answer.
     */
    const invalid = {
      status: false,
      message: "Account details are invalid",
      type: "validation_error",
      code: "invalid_params",
    };
    const { fetchImpl } = answering(invalid, 400);
    const r = await createSubAccount(
      { businessName: "Probe", accountNumber: "0000000000", bankCode: "011", email: "a@b.ng" },
      fetchImpl,
    );
    assert.ok(!r.ok);
    assert.equal(r.retryable, false);
    assert.match(r.message, /Account details are invalid/);

    const { fetchImpl: down } = answering({ status: false, message: "server error" }, 503);
    const outage = await createSubAccount(
      { businessName: "Probe", accountNumber: "0000000000", bankCode: "057", email: "a@b.ng" },
      down,
    );
    assert.ok(!outage.ok);
    assert.equal(outage.retryable, true, "a provider outage is worth one more go");
  });

  it("does not report success on a 200 with nothing in it", async () => {
    const { fetchImpl } = answering({ status: true, message: "ok", data: {} });
    const r = await createSubAccount(
      { businessName: "Probe", accountNumber: "0000000000", bankCode: "057", email: "a@b.ng" },
      fetchImpl,
    );
    assert.ok(!r.ok);
  });
});

describe("starting a card payment", () => {

  const initialised = {
    status: true,
    message: "Authorization URL created",
    data: {
      authorization_url: "https://checkout.paystack.com/p3wdd531shxurmn",
      access_code: "p3wdd531shxurmn",
      reference: "bal_abc_def",
    },
  };

  const start = async () => {
    const { fetchImpl, seen } = answering(initialised);
    const r = await initTransaction(
      {
        email: "client@acme.co.uk",
        amountKobo: 663_500_00,
        reference: "bal_abc_def",
        subaccountCode: "ACCT_yxs6g56bmt5ykjq",
        callbackUrl: "https://payment.balans.ng/pay/callback",
        metadata: { document_id: "d1", original_currency: "USD", original_amount_minor: 50_000 },
      },
      fetchImpl,
    );
    return { r, sent: seen[0]!.sent };
  };

  it("makes the subaccount bear Paystack's fee", async () => {
    /*
     * The field this whole module turns on. By default the *main* account
     * bears the charge, and the main account is ours — so without this, Balans
     * quietly pays the processing cost of every international invoice one of
     * its users sends. On a $500 invoice that is around ₦26,000, per payment,
     * for ever.
     *
     * It is accepted silently whether or not it means anything, so being sent
     * is only half of it; `verifyTransaction` below checks it stuck.
     */
    const { sent } = await start();
    assert.equal(sent.bearer, "subaccount");
    assert.equal(sent.subaccount, "ACCT_yxs6g56bmt5ykjq");
    assert.equal(sent.transaction_charge, 0);
  });

  it("charges naira, whatever the invoice was priced in", async () => {
    // Section 2: an international card is charged in naira and the client's
    // own bank converts. It is the only arrangement that settles to a
    // Nigerian account, and the dollars exist only on the document.
    const { sent } = await start();
    assert.equal(sent.currency, "NGN");
    assert.equal(sent.amount, 663_500_00);
  });

  it("offers cards and nothing else", async () => {
    // Offering bank transfer to a client in London offers something their
    // bank cannot do.
    const { sent } = await start();
    assert.deepEqual(sent.channels, ["card"]);
  });

  it("carries the invoice's own figures through the payment", async () => {
    // What was agreed and what it was converted at, so reconciliation can
    // work from the payment alone.
    const { sent } = await start();
    assert.deepEqual(sent.metadata, {
      document_id: "d1",
      original_currency: "USD",
      original_amount_minor: 50_000,
    });
  });

  it("returns the page to send the client to", async () => {
    const { r } = await start();
    assert.ok(r.ok);
    assert.equal(r.authorizationUrl, "https://checkout.paystack.com/p3wdd531shxurmn");
  });
});

describe("finding out what actually happened", () => {

  /** The real verify response for an initialised, unpaid transaction. */
  const unpaid = {
    status: true,
    message: "Verification successful",
    data: {
      reference: "bal_abc_def",
      status: "abandoned",
      amount: 66_350_000,
      currency: "NGN",
      fees: null,
      fees_split: {
        paystack: 200_000,
        integration: 0,
        subaccount: 66_150_000,
        params: { bearer: "subaccount", transaction_charge: "0", percentage_charge: "0" },
      },
      subaccount: { subaccount_code: "ACCT_yxs6g56bmt5ykjq" },
      metadata: { document_id: "d1", original_currency: "USD" },
    },
  };

  const paid = {
    status: true,
    message: "Verification successful",
    data: {
      ...unpaid.data,
      status: "success",
      paid_at: "2026-09-24T11:02:41.000Z",
      channel: "card",
      fees: 2_597_650,
      authorization: { country_code: "GB", card_type: "visa" },
    },
  };

  it("reads the bearer out of the only place it appears", async () => {
    /*
     * Not a top-level field. `fees_split.params.bearer` is the entire
     * evidence that the request did what it said, and reading it from
     * anywhere else gets null for ever — which would look exactly like a
     * bearer that never stuck.
     */
    const { fetchImpl } = answering(unpaid);
    const r = await verifyTransaction("bal_abc_def", fetchImpl);
    assert.ok(r.ok);
    assert.equal(r.transaction.bearer, "subaccount");
    assert.equal(r.transaction.subaccountCode, "ACCT_yxs6g56bmt5ykjq");
  });

  it("does not call an abandoned transaction anything else", async () => {
    // Paystack answers "Verification successful" for a transaction nobody
    // paid. The envelope's success is about the lookup, not the money.
    const { fetchImpl } = answering(unpaid);
    const r = await verifyTransaction("bal_abc_def", fetchImpl);
    assert.ok(r.ok);
    assert.equal(r.transaction.status, "abandoned");
    assert.equal(r.transaction.paidAt, null);
  });

  it("reports what was really charged, and what it really cost", async () => {
    const { fetchImpl } = answering(paid);
    const r = await verifyTransaction("bal_abc_def", fetchImpl);
    assert.ok(r.ok);
    assert.equal(r.transaction.status, "success");
    assert.equal(r.transaction.amountKobo, 66_350_000);
    assert.equal(r.transaction.currency, "NGN");
    assert.equal(r.transaction.feeKobo, 2_597_650);
    assert.equal(r.transaction.paidAt?.toISOString(), "2026-09-24T11:02:41.000Z");
  });

  it("says where the card was from, and does not guess when it cannot", async () => {
    /*
     * A Nigerian card paying an international invoice is still a valid
     * payment — section 8 says to treat it as paid, because it is an ordinary
     * naira payment. Recording which it was matters because the fee and the
     * chargeback risk differ, and null has to mean "Paystack said nothing"
     * rather than "local".
     */
    const { fetchImpl } = answering(paid);
    const abroad = await verifyTransaction("bal_abc_def", fetchImpl);
    assert.ok(abroad.ok);
    assert.equal(abroad.transaction.cardCountry, "GB");
    assert.equal(abroad.transaction.internationalCard, true);

    const { fetchImpl: local } = answering({
      ...paid,
      data: { ...paid.data, authorization: { country_code: "NG" } },
    });
    const home = await verifyTransaction("bal_abc_def", local);
    assert.ok(home.ok);
    assert.equal(home.transaction.internationalCard, false);

    const { fetchImpl: silent } = answering(unpaid);
    const unknown = await verifyTransaction("bal_abc_def", silent);
    assert.ok(unknown.ok);
    assert.equal(unknown.transaction.internationalCard, null, "null must not become false");
  });

  it("keeps the whole response, for the nightly reconciliation", async () => {
    const { fetchImpl } = answering(paid);
    const r = await verifyTransaction("bal_abc_def", fetchImpl);
    assert.ok(r.ok);
    assert.deepEqual(r.transaction.raw, paid.data);
  });

  it("does not treat a reference nobody knows as retryable", async () => {
    // The real 404 message. Asking again gets the same answer for ever.
    const { fetchImpl } = answering(
      { status: false, message: "Transaction reference not found" },
      404,
    );
    const r = await verifyTransaction("bal_nope", fetchImpl);
    assert.ok(!r.ok);
    assert.equal(r.retryable, false);
  });
});

describe("Paystack's bank codes, which are not Monnify's", () => {

  const banks = [
    { name: "Zenith Bank", code: "057" },
    { name: "Guaranty Trust Bank", code: "058" },
    { name: "First Bank of Nigeria", code: "011" },
    { name: "Kuda Bank", code: "50211" },
  ];

  it("matches a bank by name, through the noise in a name", async () => {
    /*
     * By name and never by code, because the two providers' codes are
     * different namespaces with no mapping between them. A stored Monnify
     * code sent to Paystack is refused at best; at worst it names a different
     * institution, and the user's money settles somewhere else.
     */
    assert.deepEqual(matchByName("Guaranty Trust Bank Plc", banks), { name: "Guaranty Trust Bank", code: "058" });
    assert.deepEqual(matchByName("zenith bank", banks), { name: "Zenith Bank", code: "057" });
    assert.deepEqual(matchByName("Kuda", banks), { name: "Kuda Bank", code: "50211" });
  });

  it("returns nothing rather than something close", () => {
    // A bank chosen by resemblance is somebody's payout sent to the wrong
    // institution. Null costs a support message instead.
    assert.equal(matchByName("First City Monument", banks), null);
    assert.equal(matchByName("", banks), null);
    assert.equal(matchByName("Sterling", banks), null);
  });

  it("knows the banks the two providers call different things", () => {
    /*
     * The outage this exists because of. A payout account is stored under
     * Monnify's name for the bank, and for several of the largest banks in
     * the country that name is not Paystack's: we hold "GTBank", Paystack
     * lists "Guaranty Trust Bank". Normalising case and punctuation cannot
     * bridge that, so `gtbank` never equalled `guarantytrust` and every
     * GTBank user was told, permanently, that card payment was unavailable.
     *
     * Seen live on 24 Sep 2026 — a $20 invoice whose client pressed Pay six
     * times in fifteen seconds, each one logging "no Paystack code for
     * GTBank".
     */
    assert.deepEqual(matchByName("GTBank", banks), { name: "Guaranty Trust Bank", code: "058" });
    assert.deepEqual(matchByName("First bank", banks), {
      name: "First Bank of Nigeria",
      code: "011",
    });
  });

  it("will not alias a bank whose two codes disagree", () => {
    /*
     * The table is verified by the codes agreeing, not by the names looking
     * alike, and Coronation is the reason. Monnify lists "Coronation Bank" at
     * 946; Paystack's 946 is Money Master PSB, a different company entirely,
     * and its Coronation is 559. Written from the names, that row would have
     * settled card payments into a stranger's institution.
     *
     * So it has no row, and an unaliased name still falls through to null.
     */
    const withCoronation = [...banks, { name: "Coronation Merchant Bank", code: "559" }];
    assert.equal(matchByName("Coronation Bank", withCoronation), null);
  });

  it("still refuses a bank that is on neither list", () => {
    // The alias table adds names; it must not soften the failure for one that
    // is genuinely absent. Heritage was liquidated and Paystack does not carry
    // it, so there is nothing right to return.
    assert.equal(matchByName("Heritage bank", banks), null);
  });

  it("gives an empty list rather than throwing when the lookup fails", async () => {
    const { fetchImpl } = answering({ status: false, message: "nope" }, 500);
    assert.deepEqual(await listBanks(fetchImpl), []);
  });
});
