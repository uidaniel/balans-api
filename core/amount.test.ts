import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAmountToKobo } from "./amount.ts";

/**
 * Runs the shared vectors in core/amount-vectors.json.
 *
 * The same file lives beside the web app's copy of this parser. Both suites
 * read it, so the two implementations cannot quietly disagree about what "350k"
 * means — which would show one number in the invoice generator and charge a
 * different one from the bot.
 */
const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "amount-vectors.json"), "utf8"),
) as Record<string, Record<string, number | null>>;

for (const [group, cases] of Object.entries(vectors)) {
  if (group.startsWith("_")) continue;
  describe(`amount vectors: ${group}`, () => {
    for (const [input, expected] of Object.entries(cases)) {
      it(`${JSON.stringify(input)} -> ${expected}`, () => {
        assert.equal(parseAmountToKobo(input), expected);
      });
    }
  });
}

describe("amount: properties that must always hold", () => {
  it("never returns a fraction of a kobo", () => {
    for (const s of ["350k", "1.2m", "350000.50", "0.99", "2.5k"]) {
      const v = parseAmountToKobo(s);
      assert.ok(v === null || Number.isInteger(v), `${s} gave ${v}`);
    }
  });

  it("does not drift on values a float would round", () => {
    // 1.2 * 1_000_000 * 100 in floating point is not exactly 120000000.
    assert.equal(parseAmountToKobo("1.2m"), 120_000_000);
    assert.equal(parseAmountToKobo("0.07m"), 7_000_000);
    assert.equal(parseAmountToKobo("8.28m"), 828_000_000);
  });

  it("agrees with itself across equivalent spellings", () => {
    const same = ["350k", "350K", "350,000", "₦350,000", "N350000", "350000"];
    const values = same.map(parseAmountToKobo);
    assert.equal(new Set(values).size, 1, `disagreed: ${JSON.stringify(values)}`);
  });

  it("refuses anything above the safe integer range", () => {
    assert.equal(parseAmountToKobo("999999999999m"), null);
  });
});
