/**
 * Deposits and milestones (PRD F7).
 *
 * The arithmetic is `splitInto`'s and already tested. What is tested here is
 * the ordering rule, which is what stops a client paying the balance and
 * leaving the user chasing the deposit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INSTALMENTS,
  depositShape,
  equalShape,
  nextPayable,
  shapeFor,
  type Part,
} from "./parts.ts";

const N = (naira: number) => naira * 100;

describe("the shape of a split", () => {
  it("turns a deposit into two parts that add up", () => {
    const shape = depositShape(N(100_000), 50);
    assert.deepEqual(shape.map((s) => s.amountKobo), [N(50_000), N(50_000)]);
    assert.equal(shape[0]!.label, "50% deposit");
    assert.equal(shape[1]!.label, "Balance");
  });

  it("does an uneven deposit", () => {
    const shape = depositShape(N(100_000), 30);
    assert.deepEqual(shape.map((s) => s.amountKobo), [N(30_000), N(70_000)]);
  });

  it("makes equal parts that are actually equal", () => {
    /*
     * The bug this replaced.
     *
     * A shape used to carry a percentage and the money was worked out from
     * it later. A third is 33.33% with two decimals, so three of them is
     * 99.99% of the total and the last part swallowed the rest: ₦300,000
     * "in 3 equal payments" was billed as ₦99,990, ₦99,990, ₦100,020.
     *
     * Every test passed, because every test asked whether the parts summed
     * to the total — they did, the last one made sure of it — and not one
     * asked whether the equal parts were equal.
     */
    const shape = equalShape(N(300_000), 3);
    assert.deepEqual(shape.map((s) => s.amountKobo), [N(100_000), N(100_000), N(100_000)]);
  });

  it("spreads an indivisible total by a kobo, earliest first", () => {
    // 100 kobo three ways. Somebody pays one kobo more, and it is not the
    // person waiting until the end.
    const shape = equalShape(100, 3);
    assert.deepEqual(shape.map((s) => s.amountKobo), [34, 33, 33]);
  });

  it("never loses a kobo, and never spreads more than one", () => {
    for (const total of [1, 333, N(1_000), N(50_000), N(350_001), 999_999]) {
      for (const n of [2, 3, 4, 5, 6, 7, 11, 12]) {
        const amounts = equalShape(total, n).map((s) => s.amountKobo);
        assert.equal(amounts.length, n);
        assert.equal(amounts.reduce((t, p) => t + p, 0), total, `${total} into ${n}`);

        // "Equal" has to mean equal, or as close as whole kobo allow.
        const spread = Math.max(...amounts) - Math.min(...amounts);
        assert.ok(spread <= 1, `${total} into ${n} spread by ${spread} kobo`);
      }

      for (const pct of [10, 25, 30, 50, 75]) {
        const amounts = depositShape(total, pct).map((s) => s.amountKobo);
        assert.equal(amounts.reduce((t, p) => t + p, 0), total, `${total} at ${pct}%`);
      }
    }
  });

  it("labels every part so a client can tell them apart", () => {
    assert.deepEqual(
      equalShape(N(90_000), 3).map((s) => s.label),
      ["Part 1 of 3", "Part 2 of 3", "Part 3 of 3"],
    );
  });
});

describe("only the next unpaid part is payable", () => {
  const parts = (statuses: Part["status"][]): Part[] =>
    statuses.map((status, i) => ({
      id: `p${i}`,
      position: i,
      label: `Part ${i + 1}`,
      amountKobo: N(1_000),
      status,
      paidAt: status === "paid" ? new Date() : null,
      dueOn: null,
    }));

  it("offers the first one when nothing is paid", () => {
    assert.equal(nextPayable(parts(["payable", "pending"]))?.position, 0);
  });

  it("moves on once the deposit is settled", () => {
    assert.equal(nextPayable(parts(["paid", "pending"]))?.position, 1);
  });

  it("offers nothing when everything is paid", () => {
    assert.equal(nextPayable(parts(["paid", "paid"])), null);
  });

  it("never skips an unpaid part, even out of order", () => {
    // Defensive: if a later part were somehow paid first, the earlier one is
    // still what is owed and still what the page must ask for.
    assert.equal(nextPayable(parts(["pending", "paid"]))?.position, 0);
  });
});

describe("which shape a document's options ask for", () => {
  it("gives one payment when nothing was asked for", () => {
    assert.equal(shapeFor({}, N(100_000)), null);
    assert.equal(shapeFor({ depositPercent: null, instalments: null }, N(100_000)), null);
  });

  it("reads a deposit", () => {
    assert.deepEqual(shapeFor({ depositPercent: 50 }, N(100_000)), depositShape(N(100_000), 50));
  });

  it("reads instalments", () => {
    assert.deepEqual(shapeFor({ instalments: 3 }, N(90_000)), equalShape(N(90_000), 3));
  });

  it("prefers the deposit when somehow both are set", () => {
    // They are two answers to one question. The correction reader already
    // clears one when the other is given; this is the backstop.
    assert.deepEqual(
      shapeFor({ depositPercent: 40, instalments: 3 }, N(100_000)),
      depositShape(N(100_000), 40),
    );
  });

  it("does not treat 100% as a deposit", () => {
    // depositShape(100) would make a balance worth nothing, and payment_parts
    // rejects a part of zero — a client cannot pay it, so it is not a part.
    assert.equal(shapeFor({ depositPercent: 100 }, N(100_000)), null);
    assert.equal(shapeFor({ depositPercent: 0 }, N(100_000)), null);
  });

  it("refuses a count outside what can be paid", () => {
    assert.equal(shapeFor({ instalments: 1 }, N(100_000)), null);
    assert.equal(shapeFor({ instalments: MAX_INSTALMENTS + 1 }, N(100_000)), null);
    assert.notEqual(shapeFor({ instalments: MAX_INSTALMENTS }, N(100_000)), null);
  });

  it("never produces a part worth nothing", () => {
    // Every shape that survives has to be writable: the table insists on it.
    for (const n of [2, 3, 5, 7, MAX_INSTALMENTS]) {
      const amounts = shapeFor({ instalments: n }, N(1_000))!.map((x) => x.amountKobo);
      assert.equal(amounts.length, n);
      assert.ok(amounts.every((a) => a > 0), `${n} parts of the smallest invoice`);
      assert.equal(amounts.reduce((a, b) => a + b, 0), N(1_000));
    }
  });
});
