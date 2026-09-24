import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { defaults } from "../config.ts";
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

describe("a card, which is somebody else's schedule entirely", () => {
  /*
   * The line this file's own header predicted. Monnify's 22:00 run is a fact
   * we have in writing and can compute against; Paystack's timing for an
   * international card into a subaccount is one of the open questions in
   * section 16, and we have nothing.
   *
   * Section 9 is blunt about the consequence: "Never use 'tonight' for
   * Paystack payments." Getting it wrong is not a wording mistake — it is
   * telling somebody their money is in their bank tonight when it is not,
   * in the message they will screenshot.
   */
  it("never promises tonight, whatever the clock says", () => {
    for (const hour of [0, 9, 15, 21, 22, 23]) {
      const said = arrivalLine(lagos(hour), "paystack");
      assert.doesNotMatch(said, /tonight/i, `${hour}:00 Lagos`);
      assert.doesNotMatch(said, /tomorrow night/i, `${hour}:00 Lagos`);
    }
  });

  it("says what the configuration says, so it changes without a deploy", () => {
    // One value, to be corrected the day Paystack answers section 16's third
    // question. Not computed from anything, because inventing precision here
    // would be inventing it about the reader's own money.
    assert.equal(arrivalLine(lagos(15), "paystack"), defaults.international.settlementText);
    assert.match(defaults.international.settlementText, /business days/i);
  });

  it("leaves a transfer exactly as it was", () => {
    // The default, because it is every naira payment and so nearly all of
    // them. A missing argument must never silently become the card wording.
    assert.equal(arrivalLine(lagos(15)), "Arrives in your bank tonight.");
    assert.equal(arrivalLine(lagos(15), "monnify"), "Arrives in your bank tonight.");
  });
});

describe("the poster that goes with it", () => {
  it("is not sent on a card payment", () => {
    /*
     * Both posters say "tonight" or "tomorrow night" in as many words, and
     * those are claims about Monnify's 22:00 run. Sending one with a card
     * payment puts a promise in the picture that the sentence underneath
     * contradicts — and of the two, the picture is what gets screenshotted.
     */
    const src = readFileSync(new URL("./notify.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const card ="), src.indexOf("const outcome = await send"));
    assert.match(block, /n\.provider === "paystack"\s*\?\s*undefined/);
  });
});
