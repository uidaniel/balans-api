/**
 * Deposits and milestones (PRD F7).
 *
 * The arithmetic is `splitInto`'s and already tested. What is tested here is
 * the ordering rule, which is what stops a client paying the balance and
 * leaving the user chasing the deposit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { depositShape, equalShape, nextPayable, type Part } from "./parts.ts";
import { splitInto } from "../../core/totals.ts";

const N = (naira: number) => naira * 100;

describe("the shape of a split", () => {
  it("turns a deposit into two parts that add up", () => {
    const shape = depositShape(50);
    assert.deepEqual(shape.map((s) => s.percent), [50, 50]);
    assert.equal(shape[0]!.label, "50% deposit");
    assert.equal(shape[1]!.label, "Balance");
  });

  it("does an uneven deposit", () => {
    const shape = depositShape(30);
    assert.deepEqual(shape.map((s) => s.percent), [30, 70]);
    assert.deepEqual(splitInto(N(100_000), [30, 70]), [N(30_000), N(70_000)]);
  });

  it("splits into equal parts that still total 100%", () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const shape = equalShape(n);
      assert.equal(shape.length, n);
      const total = shape.reduce((t, s) => t + s.percent, 0);
      assert.ok(Math.abs(total - 100) < 0.001, `${n} parts came to ${total}%`);
    }
  });

  it("gives the rounding remainder to the last part, as F7 says", () => {
    // Three ways is 33.33 each, and the last one carries the extra.
    const shape = equalShape(3);
    assert.equal(shape[0]!.percent, 33.33);
    assert.ok(shape[2]!.percent > shape[0]!.percent);

    const parts = splitInto(N(100_000), shape.map((s) => s.percent));
    assert.equal(parts.reduce((t, p) => t + p, 0), N(100_000));
  });

  it("never loses a kobo, at any total or any number of parts", () => {
    for (const total of [1, 333, N(1_000), N(50_000), N(350_001)]) {
      for (const n of [2, 3, 4, 5]) {
        const parts = splitInto(total, equalShape(n).map((s) => s.percent));
        assert.equal(parts.reduce((t, p) => t + p, 0), total, `${total} into ${n}`);
      }
      for (const pct of [10, 25, 30, 50, 75]) {
        const parts = splitInto(total, depositShape(pct).map((s) => s.percent));
        assert.equal(parts.reduce((t, p) => t + p, 0), total, `${total} at ${pct}%`);
      }
    }
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
