/**
 * What the draft promises against what the bank actually receives.
 *
 * The summary showed the invoice total and stopped there. That number is what
 * the client owes; it is not what arrives, and the difference is a fee agreed
 * to once during onboarding and never thought about again. The first time
 * anybody met it was on a settlement, days later, with no arithmetic in front
 * of them to check it against.
 *
 * So the draft now says it, at the one moment somebody is looking at this
 * invoice's money and can still change their mind about the plan on it.
 *
 * The figure has to be the truth, which means it has to be the *same* truth
 * `/pay` settles with. It is computed by the same `settle`, from the same
 * rates, over the same payment parts — and the tests below pin the arithmetic
 * rather than the implementation, so a rate change has to be a deliberate act
 * with numbers written down, not a quiet edit that moves what people are told
 * they will be paid.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { draftSummary, payout } from "./summary.ts";
import type { Draft } from "./store.ts";

const N = (naira: number) => naira * 100;
const today = { y: 2026, m: 9, d: 23 };

const draft = (over: Partial<Draft>): Draft =>
  ({
    id: "d1",
    clientId: "c1",
    type: "invoice",
    clientName: "Ariyo",
    clientEmail: null,
    lines: [{ description: "mobile app design", qty: 1, unitAmountKobo: N(50_000) }],
    dueDate: { y: 2026, m: 9, d: 25 },
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    subtotalKobo: N(50_000),
    vatKobo: 0,
    totalKobo: N(50_000),
    number: 7,
    publicToken: "tok",
    ...over,
  }) as Draft;

describe("what the user is told they will receive", () => {
  it("works the figure out, rather than showing the invoice total again", () => {
    // ₦50,000 on the free plan, paid in one go: 1.5% + ₦100 to the processor
    // is ₦850, and 1% to Balans is ₦500.
    assert.deepEqual(payout(draft({}), "free"), {
      receivesKobo: N(48_650),
      feesKobo: N(1_350),
    });
  });

  it("charges the fees per payment, not per invoice", () => {
    /*
     * The one worth having a test for. Fees are taken as each payment lands,
     * so the processor's flat ₦100 is met once for a single payment and three
     * times for three instalments. Taking the fee off the total instead would
     * have overstated a deposit invoice by ₦100 and a three-part plan by
     * ₦200 — small enough to look like rounding and wrong every time.
     */
    const one = payout(draft({}), "free").receivesKobo;
    const two = payout(draft({ depositPercent: 50 }), "free").receivesKobo;
    const three = payout(draft({ instalments: 3 }), "free").receivesKobo;

    assert.equal(two, one - N(100), "a deposit meets the flat charge twice");
    assert.equal(three, one - N(200), "three instalments meet it three times");
  });

  it("gives Pro back what Pro pays for", () => {
    // Pro takes no Balans fee at all, so the whole ₦500 stays with the user
    // and only the processor's cut comes out.
    assert.equal(payout(draft({}), "pro").receivesKobo, N(49_150));
  });

  it("leaves only our own fee when the client pays the transaction fee", () => {
    /*
     * Section 9: the client's total is grossed up so the user receives "the
     * invoice amount minus only the Balans fee". A user can pass on what the
     * processor charges; they cannot pass on what Balans charges, because the
     * client agreed to the invoice and not to our pricing.
     */
    const passed = payout(draft({ passFeesToClient: true }), "free");
    assert.equal(passed.receivesKobo, N(49_500));
    assert.equal(passed.feesKobo, N(500), "our fee, and nothing else");
  });

  it("never claims more than the invoice", () => {
    // A sanity net across the thresholds: the flat charge appearing at
    // ₦2,500, the processor cap at ₦2,000 and the Balans cap at ₦1,000.
    for (const naira of [1_000, 2_499, 2_500, 20_000, 500_000, 5_000_000]) {
      for (const plan of ["free", "pro"] as const) {
        const r = payout(draft({ totalKobo: N(naira), subtotalKobo: N(naira) }), plan);
        assert.ok(r.receivesKobo > 0, `${naira} on ${plan} receives nothing`);
        assert.ok(r.receivesKobo <= N(naira), `${naira} on ${plan} receives more than the invoice`);
        assert.equal(r.receivesKobo + r.feesKobo, N(naira), `${naira} on ${plan} does not add up`);
      }
    }
  });
});

describe("where it appears on the draft", () => {
  it("is the last thing before the question", () => {
    // Under the amount being approved and above the buttons, because it is
    // part of the decision rather than a footnote to it.
    const m = draftSummary(draft({ depositPercent: 50 }), today, "free");
    const ps = m.indexOf("PS:");
    const ask = m.indexOf("Send it?");

    assert.ok(ps > 0, `no PS line in:\n${m}`);
    assert.ok(ps < ask, "the PS has to come before the question");
    assert.match(m.slice(ps), /^PS: you receive \*₦48,550\* of this after fees\.\n\n\*Send it\?\*$/);
  });

  it("bolds the figure and nothing else", () => {
    /*
     * The block above already bolds the total, and the question below is bold
     * too. A third bold line would leave three things shouting on one message
     * and none of them standing out — the total is what is being approved and
     * it keeps the weight.
     */
    const m = draftSummary(draft({}), today, "free");
    const line = m.slice(m.indexOf("PS:")).split("\n")[0]!;

    assert.equal((line.match(/\*/g) ?? []).length, 2, `one bold run, not more: ${line}`);
    assert.ok(line.includes("*₦48,650*"), `the figure carries it: ${line}`);
  });

  it("says nothing about fees on a sample", () => {
    // A sample is a demonstration invoice with nobody's money in it. A fee
    // line there is a number about a client who does not exist.
    const m = draftSummary(draft({ type: "sample" }), today, "free");
    assert.ok(!m.includes("PS:"), `the sample should not talk about fees:\n${m}`);
  });

  it("tells a Pro user their own number, not the free one", () => {
    // The gate that lets a draft through already knows the plan. If this ever
    // falls back to a default, a Pro user is shown a fee they do not pay.
    assert.ok(draftSummary(draft({}), today, "pro").includes("*₦49,150*"));
    assert.ok(draftSummary(draft({}), today, "free").includes("*₦48,650*"));
  });
});
