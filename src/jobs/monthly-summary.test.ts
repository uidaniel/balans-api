/**
 * The month boundary, which is the only interesting part without a database.
 *
 * The job's real behaviour — who gets one, and that nobody gets two — lives in
 * SQL and is covered by the primary key on `monthly_summaries`. What is worth
 * testing here is the arithmetic that decides *which* month is being
 * summarised, because it is wrong for one day a year in a way nobody would
 * notice until January.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previousMonth } from "../../core/period.ts";
import { formatISO } from "../../core/dates.ts";

describe("the month a summary covers", () => {
  it("is the one that just ended", () => {
    const p = previousMonth({ y: 2026, m: 10, d: 1 });
    assert.equal(formatISO(p.from), "2026-09-01");
    assert.equal(formatISO(p.to), "2026-09-30");
    assert.equal(p.label, "September");
  });

  /*
   * The one that would go unnoticed until it happened. On 1 January the month
   * before is December of the *previous* year, and a naive `m - 1` gives month
   * zero.
   */
  it("crosses the new year correctly", () => {
    const p = previousMonth({ y: 2027, m: 1, d: 1 });
    assert.equal(formatISO(p.from), "2026-12-01");
    assert.equal(formatISO(p.to), "2026-12-31");
    // Named with the year, because "December" on 1 January reads as the one
    // coming rather than the one gone.
    assert.equal(p.label, "December 2026");
  });

  it("gets February right in a leap year", () => {
    const p = previousMonth({ y: 2028, m: 3, d: 1 });
    assert.equal(formatISO(p.to), "2028-02-29");
  });

  it("gets February right in an ordinary year", () => {
    const p = previousMonth({ y: 2027, m: 3, d: 1 });
    assert.equal(formatISO(p.to), "2027-02-28");
  });

  it("ends on the last day of every month it names", () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let m = 1; m <= 12; m++) {
      const next = m === 12 ? { y: 2027, m: 1, d: 1 } : { y: 2026, m: m + 1, d: 1 };
      const p = previousMonth(next);
      assert.equal(p.to.d, lengths[m - 1], `month ${m} ended on the wrong day`);
      assert.equal(p.from.d, 1);
      assert.equal(p.from.m, m);
    }
  });
});
