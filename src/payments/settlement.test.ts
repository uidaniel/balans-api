import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { defaults } from "../config.ts";
import { arrivalLine, settlesLine } from "./settlement.ts";

/** An instant, given as the hour and minute in Lagos. Lagos is UTC+1. */
const lagos = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 22, hour - 1, minute));

describe("when a card payment lands", () => {
  /*
   * Paystack's timing for a card into a subaccount is one of the open
   * questions in section 16, and nobody has it in writing. Section 9 is blunt
   * about the consequence: "Never use 'tonight' for Paystack payments."
   * Getting it wrong is not a wording mistake — it is telling somebody their
   * money is in their bank tonight when it is not, in the message they will
   * screenshot.
   */
  it("never promises tonight, whatever the clock says", () => {
    for (let hour = 0; hour < 24; hour++) {
      const said = arrivalLine(lagos(hour));
      assert.doesNotMatch(said, /tonight/i, `${hour}:00 Lagos`);
      assert.doesNotMatch(said, /tomorrow night/i, `${hour}:00 Lagos`);
    }
  });

  it("names the working days, from the day it was paid (17 October 2026)", () => {
    // Lagos dates; Lagos is UTC+1. 16 October 2026 is a Friday.
    const at = (d: number, h = 15) => new Date(Date.UTC(2026, 9, d, h - 1, 0));
    assert.equal(arrivalLine(at(16)), "Usually in your bank between Monday 19 Oct and Tuesday 20 Oct.");
    assert.equal(arrivalLine(at(17)), "Usually in your bank between Monday 19 Oct and Tuesday 20 Oct.", "Saturday");
    assert.equal(arrivalLine(at(18)), "Usually in your bank between Monday 19 Oct and Tuesday 20 Oct.", "Sunday");
    assert.equal(arrivalLine(at(19)), "Usually in your bank between Tuesday 20 Oct and Wednesday 21 Oct.", "Monday");
    assert.equal(arrivalLine(at(15)), "Usually in your bank between Friday 16 Oct and Monday 19 Oct.", "Thursday");
    // 00:30 Saturday in Lagos is still Friday evening UTC: Lagos decides.
    assert.equal(arrivalLine(new Date(Date.UTC(2026, 9, 16, 23, 30))), "Usually in your bank between Monday 19 Oct and Tuesday 20 Oct.");
    // Across a month end.
    assert.equal(arrivalLine(at(30)), "Usually in your bank between Monday 2 Nov and Tuesday 3 Nov.", "Friday 30 Oct");
  });

  it("forecasts in configuration's words before anybody has paid", () => {
    assert.equal(settlesLine(), defaults.international.settlementText);
  });
});

describe("the paid notice", () => {
  it("goes without a poster", () => {
    /*
     * The line underneath names working days that change with the date, and
     * a picture that promised a time would say something the words do not —
     * and of the two, the picture is what gets screenshotted.
     */
    const src = readFileSync(new URL("./notify.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function notifyPaid"), src.indexOf("export async function notifyProActive"));
    assert.doesNotMatch(fn, /image:/);
  });
});
