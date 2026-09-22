import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrivalLine, lagosHour, settlesTonight, SETTLEMENT_HOUR } from "./settlement.ts";

/** An instant, given as the hour and minute in Lagos. Lagos is UTC+1. */
const lagos = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 22, hour - 1, minute));

describe("the settlement cutoff", () => {
  it("reads the hour in Lagos, not on the server", () => {
    // 21:00 UTC is 22:00 in Lagos: the run has gone by there, whatever the
    // host thinks the time is.
    assert.equal(lagosHour(new Date(Date.UTC(2026, 8, 22, 21, 0))), 22);
    assert.equal(lagosHour(new Date(Date.UTC(2026, 8, 22, 23, 30))), 0, "past midnight Lagos");
  });

  it("catches tonight's run any time before 10 PM", () => {
    for (const h of [0, 6, 9, 13, 17, 21]) {
      assert.equal(settlesTonight(lagos(h)), true, `${h}:00 Lagos`);
    }
    assert.equal(settlesTonight(lagos(21, 59)), true, "one minute to spare");
  });

  it("misses it from 10 PM onward", () => {
    assert.equal(settlesTonight(lagos(22, 0)), false, "exactly 10 PM");
    assert.equal(settlesTonight(lagos(22, 1)), false);
    assert.equal(settlesTonight(lagos(23, 45)), false);
  });

  it("gives the boundary to the later side", () => {
    // A payment at exactly 22:00 has not beaten the run. Promising somebody
    // their money tonight when it arrives tomorrow is the one error here that
    // costs trust, so the tie goes to the cautious answer.
    assert.equal(settlesTonight(lagos(SETTLEMENT_HOUR)), false);
    assert.equal(settlesTonight(lagos(SETTLEMENT_HOUR - 1, 59)), true);
  });

  it("does not skip weekends", () => {
    // 26 September 2026 is a Saturday, 27th a Sunday. Monnify settles every
    // day of the year, which is the whole reason this replaced "next business
    // day" — a Friday payment used to be described as landing on Monday.
    const saturday = new Date(Date.UTC(2026, 8, 26, 14, 0));
    const sunday = new Date(Date.UTC(2026, 8, 27, 14, 0));
    assert.equal(saturday.getUTCDay(), 6);
    assert.equal(sunday.getUTCDay(), 0);
    assert.equal(settlesTonight(saturday), true);
    assert.equal(settlesTonight(sunday), true);
  });

  it("says it in the second person, about tonight or tomorrow night", () => {
    assert.equal(arrivalLine(lagos(15)), "Arrives in your bank tonight.");
    assert.equal(arrivalLine(lagos(23)), "Arrives in your bank tomorrow night.");
  });
});
