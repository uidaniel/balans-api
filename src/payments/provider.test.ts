/**
 * Two processors, one answer to "is this really paid?".
 *
 * `confirmPayment` holds every rule that decides whether money moved: verify
 * by API, refuse a mismatched reference, refuse a currency that is not NGN,
 * refuse an amount short of what was asked, be idempotent against redelivery,
 * send anything that disagrees to `needs_review`. Paystack does not get a
 * second copy of those rules — it gets an adapter into the shape they already
 * read, because a second copy is a second answer waiting to drift.
 *
 * Which puts the whole risk in this file. A mapping mistake here is silent:
 * every field has a plausible value and nothing downstream can tell that
 * `abandoned` was read as paid, or that a fee of null became a settlement of
 * zero. So each one is checked against a response the sandbox really
 * returned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const KEY = "sk_test_0000000000000000000000000000000000000000";
process.env.PAYSTACK_SECRET_KEY = KEY;

const { providerFor, verifyWithPaystack, verifierFor } = await import("./provider.ts");

const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

/** A paid international card, in the shape Paystack sends it. */
const paid = {
  status: true,
  message: "Verification successful",
  data: {
    reference: "bal_abc_def",
    status: "success",
    amount: 66_350_000,
    currency: "NGN",
    paid_at: "2026-09-24T11:02:41.000Z",
    channel: "card",
    fees: 2_597_650,
    fees_split: { params: { bearer: "subaccount" } },
    subaccount: { subaccount_code: "ACCT_yxs6g56bmt5ykjq" },
    authorization: { country_code: "GB" },
  },
};

describe("which processor collects", () => {
  it("sends naira to Monnify and everything else to Paystack", () => {
    // Section 8's routing table, and the reason both exist: Monnify does not
    // charge international cards at all, and Paystack is not how a Nigerian
    // client pays by bank transfer.
    assert.equal(providerFor("NGN"), "monnify");
    assert.equal(providerFor("USD"), "paystack");
    assert.equal(providerFor("GBP"), "paystack");
  });

  it("hands back a verifier rather than a branch at the call site", () => {
    assert.equal(verifierFor("paystack"), verifyWithPaystack);
    assert.notEqual(verifierFor("monnify"), verifyWithPaystack);
  });
});

describe("Paystack's answer, in the shape the confirmation path reads", () => {
  it("carries a successful charge through with its figures intact", async () => {
    const r = await verifyWithPaystack("bal_abc_def", answering(paid));
    assert.ok(r.ok);
    const t = r.transaction;
    assert.equal(t.paymentStatus, "PAID");
    assert.equal(t.amountPaidKobo, 66_350_000);
    assert.equal(t.currency, "NGN");
    assert.equal(t.paymentMethod, "card");
    assert.equal(t.paidOn, "2026-09-24T11:02:41.000Z");
  });

  it("does not call an abandoned transaction paid", async () => {
    /*
     * The mapping mistake that would matter most. Paystack answers
     * "Verification successful" for a transaction nobody ever paid and calls
     * it abandoned — the envelope's success is about the lookup, not the
     * money. Read as paid, every initialised payment settles its invoice the
     * moment anything asks about it.
     */
    const abandoned = { ...paid, data: { ...paid.data, status: "abandoned", fees: null, paid_at: undefined } };
    const r = await verifyWithPaystack("bal_abc_def", answering(abandoned));
    assert.ok(r.ok);
    assert.equal(r.transaction.paymentStatus, "ABANDONED");
    assert.equal(r.transaction.paidOn, null);
  });

  it("maps every status Paystack can send, and nothing to PAID by accident", async () => {
    const cases: [string, string][] = [
      ["success", "PAID"],
      ["failed", "FAILED"],
      ["abandoned", "ABANDONED"],
      ["pending", "PENDING"],
      ["ongoing", "PENDING"],
      ["reversed", "REVERSED"],
      // Something new, or something we misread. Pending is the safe end of
      // that: it settles nothing and it marks nothing failed.
      ["something_new_they_added", "PENDING"],
    ];
    for (const [from, to] of cases) {
      const r = await verifyWithPaystack(
        "bal_abc_def",
        answering({ ...paid, data: { ...paid.data, status: from } }),
      );
      assert.ok(r.ok);
      assert.equal(r.transaction.paymentStatus, to, from);
    }
  });

  it("says nothing about the settlement until the fee is known", async () => {
    /*
     * The fee is null until the card is charged, because Paystack cannot know
     * where a card is from until it is used. Null has to stay null: reading
     * it as zero would report the gross amount as what settles, which on a
     * $500 invoice overstates the freelancer's share by about ₦26,000 in
     * whatever reads it next.
     */
    const unpaid = { ...paid, data: { ...paid.data, status: "abandoned", fees: null } };
    const r = await verifyWithPaystack("bal_abc_def", answering(unpaid));
    assert.ok(r.ok);
    assert.equal(r.transaction.settlementAmountKobo, null);

    const settled = await verifyWithPaystack("bal_abc_def", answering(paid));
    assert.ok(settled.ok);
    assert.equal(settled.transaction.settlementAmountKobo, 66_350_000 - 2_597_650);
  });

  it("puts our own reference on both sides, because there is only one", async () => {
    /*
     * Monnify echoes a second identifier of its own, and a mismatch between
     * the two means we are about to credit the wrong document. Paystack
     * verifies by the reference we set and has no second string, so the check
     * compares ours against ours. Stated here so that nobody later reads the
     * passing check as evidence of something it is not testing.
     */
    const r = await verifyWithPaystack("bal_abc_def", answering(paid));
    assert.ok(r.ok);
    assert.equal(r.transaction.paymentReference, "bal_abc_def");
    assert.equal(r.transaction.transactionReference, "bal_abc_def");
  });

  it("keeps a currency that is not naira, so the confirmation can refuse it", async () => {
    // The adapter must not normalise this away. Section 8: mark paid only if
    // the currency is NGN, and `confirmPayment` is what enforces that — it
    // can only do so if what it is handed is the truth.
    const usd = { ...paid, data: { ...paid.data, currency: "USD" } };
    const r = await verifyWithPaystack("bal_abc_def", answering(usd));
    assert.ok(r.ok);
    assert.equal(r.transaction.currency, "USD");
  });

  it("reports a failed lookup as a failure, not as an unpaid transaction", async () => {
    /*
     * The difference decides whether Paystack is asked to retry. A lookup we
     * could not make means we do not know; a transaction that is not paid
     * means we do. Collapsing the first into the second would acknowledge a
     * webhook for a payment nobody ever checked.
     */
    const r = await verifyWithPaystack(
      "bal_abc_def",
      answering({ status: false, message: "Transaction reference not found" }, 404),
    );
    assert.ok(!r.ok);
    assert.match(r.message, /not found/);
  });
});
