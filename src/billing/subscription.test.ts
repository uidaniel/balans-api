/**
 * The subscription deduction cap (PRD F18).
 *
 * "The total Balans charge on any single payment may not exceed 20% of that
 * payment; any remainder carries to the following payment."
 *
 * This is the rule that decides whether a user trusts the deduct-from-invoice
 * option at all. Without it a ₦5,000 invoice arrives with ₦4,000 taken out.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deductionFor, MAX_CHARGE_SHARE_BPS } from "./subscription.ts";

const N = (naira: number) => naira * 100;

describe("how much of a payment the subscription can take", () => {
  it("takes the whole thing when there is room", () => {
    // 20% of 100,000 is 20,000. Our fee is 1,000, leaving 19,000 of room for
    // a 4,000 subscription.
    const d = deductionFor(N(100_000), N(1_000), N(4_000));
    assert.equal(d.takeKobo, N(4_000));
    assert.equal(d.carryKobo, 0);
  });

  it("takes only what the cap allows, and carries the rest", () => {
    // 20% of 20,000 is 4,000. Our fee is 200, so 3,800 of room.
    const d = deductionFor(N(20_000), N(200), N(4_000));
    assert.equal(d.takeKobo, N(3_800));
    assert.equal(d.carryKobo, N(200));
  });

  it("takes nothing when our own fee has already reached the cap", () => {
    // A 2,000 payment: the cap is 400 and the minimum fee is 100... but on a
    // tiny payment the fee can eat the lot, and then the subscription waits.
    const d = deductionFor(N(2_000), N(400), N(4_000));
    assert.equal(d.takeKobo, 0);
    assert.equal(d.carryKobo, N(4_000), "nothing is forgiven, it carries");
  });

  it("never takes more than is owed", () => {
    const d = deductionFor(N(1_000_000), N(1_000), N(500));
    assert.equal(d.takeKobo, N(500));
    assert.equal(d.carryKobo, 0);
  });

  it("takes nothing when nothing is owed", () => {
    assert.deepEqual(deductionFor(N(100_000), N(1_000), 0), { takeKobo: 0, carryKobo: 0 });
  });

  it("never returns a negative carry", () => {
    const d = deductionFor(N(100_000), N(1_000), -500);
    assert.equal(d.carryKobo, 0);
  });
});

describe("the cap holds whatever the numbers", () => {
  it("our total charge never exceeds a fifth of the payment", () => {
    const payments = [1_000, 2_000, 5_000, 20_000, 50_000, 100_000, 350_000, 1_000_000];
    const fees = [100, 200, 500, 1_000];
    const owed = [500, 2_000, 4_000, 8_000];

    for (const p of payments) {
      for (const f of fees) {
        for (const o of owed) {
          const d = deductionFor(N(p), N(f), N(o));
          const total = N(f) + d.takeKobo;
          const ceiling = Math.floor((N(p) * MAX_CHARGE_SHARE_BPS) / 10_000);

          // The transaction fee alone can exceed the cap on a tiny payment —
          // that fee is not ours to defer. What must never happen is the
          // subscription pushing it over.
          if (N(f) <= ceiling) {
            assert.ok(total <= ceiling, `${p}/${f}/${o}: took ${total}, cap ${ceiling}`);
          } else {
            assert.equal(d.takeKobo, 0, `${p}/${f}/${o}: took from an already-capped payment`);
          }
        }
      }
    }
  });

  it("never loses a kobo: what is taken plus what carries is what was owed", () => {
    for (const p of [1_000, 20_000, 350_000]) {
      for (const o of [500, 4_000, 12_000]) {
        const d = deductionFor(N(p), N(500), N(o));
        assert.equal(d.takeKobo + d.carryKobo, N(o), `${p}/${o} does not close`);
      }
    }
  });

  it("leaves the user the large majority of every payment", () => {
    // The point of the cap, stated as the thing a user would check.
    for (const p of [5_000, 20_000, 100_000]) {
      const d = deductionFor(N(p), N(500), N(4_000));
      const takenTotal = N(500) + d.takeKobo;
      assert.ok(takenTotal <= N(p) * 0.2 + 1, `${p}: we took ${takenTotal}`);
    }
  });
});
