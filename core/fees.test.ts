import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  balansFee,
  DEFAULT_PROCESSOR,
  grossUp,
  processorFee,
  settle,
  type BalansRates,
} from "./fees.ts";

const N = (naira: number) => Math.round(naira * 100);

/** Section 2's plans, as the config defaults them. */
const FREE: BalansRates = { percentBps: 100, minKobo: N(100), capKobo: N(1_000) };
const PRO: BalansRates = { percentBps: 50, minKobo: N(50), capKobo: N(500) };

describe("the processor's fee", () => {
  it("waives the flat charge below the threshold", () => {
    // 1.5% of 2,000 is 30, and the 100 is waived under 2,500.
    assert.equal(processorFee(N(2_000)), N(30));
    assert.equal(processorFee(N(2_499)), N(37.485));
  });

  it("adds the flat charge at and above the threshold", () => {
    assert.equal(processorFee(N(2_500)), N(137.5));
    assert.equal(processorFee(N(20_000)), N(400));
    assert.equal(processorFee(N(50_000)), N(850));
  });

  it("stops at the cap", () => {
    assert.equal(processorFee(N(350_000)), N(2_000));
    assert.equal(processorFee(N(10_000_000)), N(2_000));
  });

  it("is nothing on nothing", () => {
    assert.equal(processorFee(0), 0);
    assert.equal(processorFee(-100), 0);
  });
});

describe("the Balans fee", () => {
  it("is a percentage between a floor and a cap", () => {
    assert.equal(balansFee(N(20_000), FREE), N(200));
    assert.equal(balansFee(N(50_000), FREE), N(500));
  });

  it("uses the minimum on small invoices", () => {
    // 1% of 2,000 is 20, which is below the 100 floor.
    assert.equal(balansFee(N(2_000), FREE), N(100));
    assert.equal(balansFee(N(1_000), FREE), N(100));
  });

  it("uses the cap on large ones", () => {
    assert.equal(balansFee(N(350_000), FREE), N(1_000));
    assert.equal(balansFee(N(5_000_000), FREE), N(1_000));
  });

  it("is half as much on Pro", () => {
    assert.equal(balansFee(N(50_000), PRO), N(250));
    assert.equal(balansFee(N(350_000), PRO), N(500));
    assert.equal(balansFee(N(2_000), PRO), N(50));
  });

  it("halves after the cap for a referral, not before", () => {
    // 1% of 350,000 is 3,500, capped to 1,000, then halved to 500. Halving
    // first would give 1,000, which is a different answer on every large one.
    assert.equal(balansFee(N(350_000), FREE, { referralHalved: true }), N(500));
    assert.equal(balansFee(N(20_000), FREE, { referralHalved: true }), N(100));
  });
});

describe("section 9's worked examples, user absorbs the fees", () => {
  // Invoice | processor | Balans | user receives
  const table: [number, number, number, number][] = [
    [2_000, 30, 100, 1_870],
    [20_000, 400, 200, 19_400],
    [50_000, 850, 500, 48_650],
    [350_000, 2_000, 1_000, 347_000],
  ];

  for (const [invoice, processor, balans, receives] of table) {
    it(`${invoice.toLocaleString()} -> user gets ${receives.toLocaleString()}`, () => {
      const s = settle(N(invoice), FREE);
      assert.equal(s.clientPaysKobo, N(invoice), "the client pays the invoice amount");
      assert.equal(s.processorFeeKobo, N(processor));
      assert.equal(s.balansFeeKobo, N(balans));
      assert.equal(s.userReceivesKobo, N(receives));
    });
  }
});

describe("section 9's worked example, fees passed to the client", () => {
  it("grosses 50,000 up to 50,862.95 and leaves the user with 49,500", () => {
    const s = settle(N(50_000), FREE, { passToClient: true });
    assert.equal(s.clientPaysKobo, N(50_862.95));
    assert.equal(s.balansFeeKobo, N(500));
    // The user receives the invoice amount minus only the Balans fee.
    assert.equal(s.userReceivesKobo, N(49_500));
    assert.equal(
      s.clientPaysKobo - s.processorFeeKobo - s.balansFeeKobo,
      s.userReceivesKobo,
      "the three shares must account for every kobo",
    );
  });
});

describe("the user is never short", () => {
  // The property that matters more than any single example: with fees passed
  // on, what the user receives is the invoice amount minus the Balans fee, to
  // the kobo, at every amount and on every plan.
  const amounts = [
    1_000, 1_001, 2_000, 2_400, 2_460, 2_465, 2_499, 2_500, 2_501, 5_000,
    10_000, 20_000, 49_999, 50_000, 99_999, 100_000, 131_000, 131_500,
    350_000, 1_000_000, 2_000_000,
  ];

  for (const plan of [
    ["Free", FREE],
    ["Pro", PRO],
  ] as const) {
    it(`holds on ${plan[0]}`, () => {
      for (const naira of amounts) {
        const invoice = N(naira);
        const s = settle(invoice, plan[1], { passToClient: true });
        const expected = invoice - s.balansFeeKobo;

        assert.equal(
          s.userReceivesKobo,
          expected,
          `${naira}: user got ${s.userReceivesKobo}, should be ${expected}`,
        );
        assert.ok(
          s.clientPaysKobo >= invoice,
          `${naira}: the client was charged less than the invoice`,
        );
      }
    });
  }

  it("never overcharges the client by more than a kobo", () => {
    // A kobo of slack is the price of closing the arithmetic. More than that
    // and somebody is being quietly overcharged.
    for (const naira of amounts) {
      const invoice = N(naira);
      const total = grossUp(invoice);
      const oneLess = total - 1;
      const shortfall = invoice - (oneLess - processorFee(oneLess));
      assert.ok(shortfall > 0, `${naira}: could have charged a kobo less`);
    }
  });
});

describe("every kobo is accounted for", () => {
  it("the three shares always add back to what the client paid", () => {
    for (const naira of [1_000, 2_000, 2_500, 20_000, 50_000, 350_000, 1_000_000]) {
      for (const passToClient of [false, true]) {
        for (const referralHalved of [false, true]) {
          const s = settle(N(naira), FREE, { passToClient, referralHalved });
          assert.equal(
            s.processorFeeKobo + s.balansFeeKobo + s.userReceivesKobo,
            s.clientPaysKobo,
            `${naira} pass=${passToClient} referral=${referralHalved} does not close`,
          );
          assert.ok(s.userReceivesKobo > 0, "the user must receive something");
        }
      }
    }
  });

  it("adds a subscription deduction to our share, not the processor's", () => {
    const plain = settle(N(50_000), PRO);
    const deducted = settle(N(50_000), PRO, { subscriptionDeductionKobo: N(4_000) });

    assert.equal(deducted.balansFeeKobo, plain.balansFeeKobo + N(4_000));
    assert.equal(deducted.processorFeeKobo, plain.processorFeeKobo);
    assert.equal(deducted.userReceivesKobo, plain.userReceivesKobo - N(4_000));
  });
});

describe("grossing up around the awkward points", () => {
  it("stays under the threshold when it can", () => {
    // Small enough that the flat charge is waived, and grossing up must not
    // push it over on its own.
    const total = grossUp(N(1_000));
    assert.ok(total < N(2_500), `grossed up to ${total}, over the waiver`);
  });

  it("copes when grossing up crosses the threshold", () => {
    // An invoice just under 2,500 whose total lands just over it, where the
    // flat charge appears out of nowhere.
    for (const naira of [2_400, 2_450, 2_460, 2_470, 2_480, 2_490, 2_499]) {
      const invoice = N(naira);
      const total = grossUp(invoice);
      assert.ok(total - processorFee(total) >= invoice, `${naira} left the user short`);
    }
  });

  it("copes past the cap, where the fee stops growing", () => {
    const invoice = N(1_000_000);
    assert.equal(grossUp(invoice), invoice + DEFAULT_PROCESSOR.capKobo);
  });

  it("is nothing on nothing", () => {
    assert.equal(grossUp(0), 0);
  });
});
