import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { titleCaseName } from "./names.ts";

describe("writing a name properly", () => {
  const cases: [string, string][] = [
    ["edidiong uwak", "Edidiong Uwak"],
    ["tunde", "Tunde"],
    ["zenith homes limited", "Zenith Homes Limited"],
    ["  kemi   adeyemi  ", "Kemi Adeyemi"],
    // Small words stay small, except at the start.
    ["bank of the north", "Bank of the North"],
    ["the bank", "The Bank"],
    // Apostrophes and hyphens get a capital after them.
    ["o'brien", "O'Brien"],
    ["ada-obi", "Ada-Obi"],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(titleCaseName(input), expected);
    });
  }
});

describe("capitals somebody chose are left alone", () => {
  // A word with a capital in it was typed that way on purpose. Lower-casing
  // "MTN" to "Mtn" would be worse than leaving a name uncapitalised.
  const kept = ["MTN", "MTN Nigeria", "iCreate", "MoMo Agent", "GTBank", "UBA Plc", "O'Brien"];

  for (const name of kept) {
    it(`${JSON.stringify(name)} is untouched`, () => {
      assert.equal(titleCaseName(name), name);
    });
  }

  it("fixes only the words that need it", () => {
    assert.equal(titleCaseName("mtn nigeria"), "Mtn Nigeria");
    assert.equal(titleCaseName("MTN nigeria"), "MTN Nigeria");
  });
});

describe("it never makes a name worse", () => {
  it("leaves an empty name empty", () => {
    assert.equal(titleCaseName(""), "");
    assert.equal(titleCaseName("   "), "");
  });

  it("keeps every character it was given", () => {
    for (const n of ["edidiong uwak", "MTN", "bank of the north", "o'brien"]) {
      assert.equal(
        titleCaseName(n).toLowerCase().replace(/\s+/g, " ").trim(),
        n.toLowerCase().replace(/\s+/g, " ").trim(),
      );
    }
  });
});
