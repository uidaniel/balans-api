/**
 * Reading money for somebody who lives outside Nigeria (Phase 3).
 *
 * A bare amount is in their own currency; naira has to be said; another
 * currency beside it is the usual question.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCurrencyAt } from "./currency.ts";
import { ownDetailsText } from "../src/documents/bank-details.ts";

const show = (r: ReturnType<typeof readCurrencyAt>): string =>
  r.kind === "foreign" ? `${r.currency} ${r.amountMinor}` : r.kind === "mixed" ? "mixed" : r.kind === "unsupported" ? `no:${r.named}` : "NGN";

describe("readCurrencyAt, from London", () => {
  const at = (t: string) => show(readCurrencyAt(t, "GBP"));

  it("reads a bare amount as pounds", () => {
    assert.equal(at("invoice Acme 5000 for the logo"), "GBP 500000");
    assert.equal(at("invoice Acme 2.5k for the site"), "GBP 250000");
  });

  it("still reads pounds said out loud", () => {
    assert.equal(at("invoice Acme £500 for the logo"), "GBP 50000");
  });

  it("takes naira only when it is said", () => {
    assert.equal(at("invoice Tunde ₦50,000 for the flyer"), "NGN");
    assert.equal(at("invoice Tunde 50000 naira for the flyer"), "NGN");
  });

  it("keeps another currency as it was written", () => {
    assert.equal(at("invoice Acme $500 for the logo"), "USD 50000");
    assert.equal(at("invoice Acme $500 or 7000 for the logo"), "mixed");
  });

  it("does not ask which one when both are theirs", () => {
    assert.equal(at("invoice Acme £500 for the logo and 2000 for the site"), "GBP null");
  });

  it("still refuses what nobody takes", () => {
    assert.equal(at("invoice Acme ¥50000 for the logo"), "no:yen");
  });
});

describe("readCurrencyAt, from Nigeria", () => {
  it("is readCurrency exactly", () => {
    assert.equal(show(readCurrencyAt("invoice Tunde 50000 for the flyer", null)), "NGN");
    assert.equal(show(readCurrencyAt("invoice Acme $500 for the logo", null)), "USD 50000");
  });
});

describe("ownDetailsText", () => {
  it("puts the method over the details", () => {
    assert.equal(ownDetailsText("PayPal", "me@example.com"), "PayPal\nme@example.com");
  });
  it("does not say it twice", () => {
    assert.equal(ownDetailsText("PayPal", "PayPal: me@example.com"), "PayPal: me@example.com");
  });
  it("is just the details with no method", () => {
    assert.equal(ownDetailsText(null, " IBAN GB00 "), "IBAN GB00");
  });
});
