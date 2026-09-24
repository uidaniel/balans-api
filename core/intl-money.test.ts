/**
 * The arithmetic of an invoice priced abroad and paid here.
 *
 * The International PRD gives one worked example and it is the whole
 * specification of this path, so it is the first test. Everything else here
 * exists because of one property: the freelancer is never told a dollar
 * figure they will not receive the naira equivalent of, and the client is
 * never charged a figure that does not clear the invoice.
 *
 * The gross-up is the sharp end. Off by a kobo in the client's favour and the
 * freelancer is short on every fee-passing invoice they ever send, quietly,
 * for ever — the same class of bug as the local one that credited an invoice
 * with its own surcharge, and just as invisible without a test that does the
 * arithmetic the other way round.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INTL_PROCESSOR,
  grossUp,
  processorFee,
  settle,
  withVat,
  type BalansRates,
} from "./fees.ts";
import { impliedRate, isSaneRate, nairaKoboFor } from "./exchange.ts";

/** Pro, which is the only plan that can invoice abroad. Section 7: no fee. */
const PRO: BalansRates = { percentBps: 0, minKobo: 0, capKobo: 0 };

/** The rate in the PRD's worked example. */
const RATE = 1327;

describe("the PRD's worked example", () => {
  /*
   *   Invoice                    $500.00
   *   Charged to client        ₦663,500
   *   Paystack fee (3.9% + ₦100) ₦25,977
   *   Balans fee                      ₦0
   *   User receives            ₦637,523   (≈ $480)
   *
   * The PRD's table is rounded to whole naira for the page. The engine works
   * in kobo and the figures below are that table to the kobo: the fee is
   * ₦25,976.50 and the user receives ₦637,523.50. Asserting the PRD's
   * rounded numbers as if they were exact would have been asserting a
   * typesetting decision.
   */
  const charge = nairaKoboFor(500_00, RATE);

  it("converts the price at the locked rate", () => {
    assert.equal(charge, 663_500_00);
  });

  it("takes 3.9% and ₦100, rounded the processor's way", () => {
    assert.equal(processorFee(charge, DEFAULT_INTL_PROCESSOR), 25_976_50);
  });

  it("leaves the user ₦637,523.50, and Balans nothing", () => {
    const s = settle(charge, PRO, { processor: DEFAULT_INTL_PROCESSOR });
    assert.equal(s.balansFeeKobo, 0);
    assert.equal(s.userReceivesKobo, 637_523_50);
    assert.equal(s.clientPaysKobo, charge);
  });

  it("grosses up to about ₦690,500 when the fee is passed on", () => {
    // The PRD writes "≈ ₦690,500". The exact answer is ₦690,530.70, and the
    // difference is the PRD rounding for the page rather than an error: at
    // ₦690,500 the user would be ₦29.51 short of their $500.
    const s = settle(charge, PRO, { processor: DEFAULT_INTL_PROCESSOR, passToClient: true });
    assert.equal(s.clientPaysKobo, 690_530_70);
    assert.equal(s.userReceivesKobo, charge);
  });
});

describe("the gross-up, which may never leave the user short", () => {
  it("clears the invoice exactly, for a thousand amounts", () => {
    /*
     * Section 7 asks for this by name. Random rather than chosen, because the
     * failure is a rounding one and rounding failures live in the gaps
     * between the amounts anybody would think to write down.
     */
    for (let i = 0; i < 1000; i++) {
      // ₦1,000 to ₦50,000,000, at a whole kobo.
      const invoice = 1_000_00 + Math.floor(Math.random() * 4_999_900_00);
      const total = grossUp(invoice, DEFAULT_INTL_PROCESSOR);
      const left = total - processorFee(total, DEFAULT_INTL_PROCESSOR);

      assert.ok(left >= invoice, `₦${invoice / 100}: user left with ${left}, short by ${invoice - left}`);
      // And not wastefully over: a kobo or two of rounding, never a naira.
      assert.ok(left - invoice < 100, `₦${invoice / 100}: client overcharged by ${left - invoice}`);
    }
  });

  it("holds with VAT on the fee as well as off it", () => {
    const vatted = withVat(DEFAULT_INTL_PROCESSOR, 7.5);
    for (const invoice of [1_000_00, 66_350_000, 1_000_000_00, 49_000_000_00]) {
      const total = grossUp(invoice, vatted);
      assert.ok(total - processorFee(total, vatted) >= invoice);
    }
  });
});

describe("VAT on the card fee", () => {
  it("is a change to one number, not a third fee", () => {
    /*
     * VAT is charged on the fee, so 3.9% + ₦100 with 7.5% VAT *is* 4.1925% +
     * ₦107.50. Folding it in means every cap, floor, gross-up and rounding
     * rule already written applies to it, with no branch anywhere asking
     * whether this transaction is the VAT kind.
     */
    const vatted = withVat(DEFAULT_INTL_PROCESSOR, 7.5);
    assert.equal(vatted.percentBps, 420); // 390 × 1.075 = 419.25, rounded up
    assert.equal(vatted.flatKobo, 107_50);

    const plain = processorFee(663_500_00, DEFAULT_INTL_PROCESSOR);
    assert.ok(processorFee(663_500_00, vatted) > plain, "VAT must cost more than no VAT");
  });

  it("is off until Paystack says otherwise", () => {
    // Section 7: "intl_vat_pct: 0 until confirmed". An assumed tax charged to
    // a real client is worse than an unassumed one.
    assert.deepEqual(withVat(DEFAULT_INTL_PROCESSOR, 0), DEFAULT_INTL_PROCESSOR);
  });
});

describe("how the international schedule differs from the local one", () => {
  it("has no cap, so a big invoice pays a big fee", () => {
    /*
     * Monnify's cut stops at ₦2,000. Paystack's international one does not,
     * and on a $10,000 invoice that is the difference between ₦2,000 and
     * about ₦517,000. Capping it here because the local one is capped would
     * be inventing ₦515,000 of somebody else's money.
     */
    const tenGrand = nairaKoboFor(10_000_00, RATE);
    assert.equal(processorFee(tenGrand, DEFAULT_INTL_PROCESSOR), 517_630_00);
  });

  it("always charges the flat ₦100", () => {
    // The local waiver below ₦2,500 is a courtesy on small local transfers.
    // It has nothing to say about a card from abroad.
    assert.equal(DEFAULT_INTL_PROCESSOR.flatWaivedBelowKobo, 0);
    assert.equal(processorFee(1_000_00, DEFAULT_INTL_PROCESSOR), 39_00 + 100_00);
  });
});

describe("converting at all", () => {
  it("is cents times the rate, because both have two minor digits", () => {
    assert.equal(nairaKoboFor(500_00, 1327), 663_500_00);
    assert.equal(nairaKoboFor(500_00, 1326.871066), 663_436_00);
    assert.equal(nairaKoboFor(1_200_00, 1791.751317), 2_150_102_00);
  });

  it("lands on a whole naira, which is what somebody has to type", () => {
    for (const rate of [1326.871066, 1791.751317, 1500.005]) {
      for (const cents of [1_00, 499_99, 12_345_67]) {
        assert.equal(nairaKoboFor(cents, rate) % 100, 0);
      }
    }
  });

  it("rounds to nearest, because rounding up is a margin nobody agreed", () => {
    // ₦0.49 down, ₦0.50 up. A margin may well be the right idea one day, but
    // it would be a decision with a number and a name, not a rounding rule.
    assert.equal(nairaKoboFor(100, 1000.49), 1_000_00);
    assert.equal(nairaKoboFor(100, 1000.51), 1_001_00);
  });

  it("refuses a rate that cannot be one", () => {
    /*
     * The feed is somebody else's JSON. A null coerced to zero, or a rate
     * quoted the other way round, would price a month of work at nothing —
     * and an invoice for nothing is one a client can settle for nothing.
     */
    for (const bad of [0, -1327, 0.00075, NaN, Infinity, null, undefined, "1327"]) {
      assert.equal(isSaneRate(bad), false, `${String(bad)} was accepted as a rate`);
    }
    assert.ok(isSaneRate(1326.871066));
    assert.throws(() => nairaKoboFor(500_00, 0), RangeError);
  });

  it("can say the rate back from the two figures on the invoice", () => {
    // The draft says "today's rate ₦1,327/$" beside the charge. Deriving it
    // from the charge means the sentence and the figure cannot disagree,
    // including years later on an invoice whose rate stopped being today's.
    assert.equal(impliedRate(663_500_00, 500_00), 1327);
    assert.equal(Math.round(impliedRate(nairaKoboFor(500_00, 1326.871066), 500_00)), 1327);
  });
});
