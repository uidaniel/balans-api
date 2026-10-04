import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { proPriceAbroad } from "./pro-price.ts";

describe("proPriceAbroad", () => {
  const cases: [string, string | null][] = [
    ["2348012345678", null],
    ["12025550123", "USD 500"],
    ["447700900123", "GBP 400"],
    ["4915112345678", "EUR 500"],
    ["14165550123", "CAD 700"],
    ["61412345678", "AUD 800"],
    ["971501234567", "AED 1900"],
    ["233201234567", "GHS 3500"],
    ["254712345678", "KES 40000"],
    ["27821234567", "ZAR 5900"],
    // Anywhere not named: five dollars, never naira.
    ["8613800000000", "USD 500"],
    ["919812345678", "USD 500"],
  ];
  for (const [phone, want] of cases) {
    it(`${phone} → ${want ?? "naira price"}`, () => {
      const p = proPriceAbroad(phone);
      assert.equal(p ? `${p.currency} ${p.minor}` : null, want);
    });
  }
});
