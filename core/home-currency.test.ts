import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { homeCurrencyFor } from "./home-currency.ts";

describe("homeCurrencyFor", () => {
  const cases: [string, string][] = [
    ["2348012345678", "NGN"],
    ["+44 7700 900123", "GBP"],
    ["12025550123", "USD"],
    ["14165550123", "CAD"],
    ["61412345678", "AUD"],
    ["233201234567", "GHS"],
    ["254712345678", "KES"],
    ["27821234567", "ZAR"],
    ["971501234567", "AED"],
    ["4915112345678", "EUR"],
    ["353871234567", "EUR"],
    ["0033612345678", "EUR"],
    ["8613800000000", "NGN"],
    ["", "NGN"],
  ];
  for (const [phone, want] of cases) {
    it(`${phone || "(none)"} → ${want}`, () => assert.equal(homeCurrencyFor(phone), want));
  }
});
