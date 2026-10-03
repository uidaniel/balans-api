/**
 * How a client abroad pays: a Balans link, or the sender's own details.
 *
 * Said when the invoice is asked for ("…pay by my paypal") or as a correction
 * to the draft ("use my details"). Getting it wrong either way is visible to
 * the client, so words that merely mention PayPal must not switch it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { payByIn, readCorrection } from "./corrections.ts";

const today = { y: 2026, m: 10, d: 3 };

describe("payByIn", () => {
  for (const text of [
    "use my paypal",
    "they'll pay with wise",
    "pay by my paypal details",
    "use my payment details",
    "send it with my details",
    "no payment link",
    "don't send a link",
    "client pays via paypal",
    "my iban",
  ]) {
    it(`own: ${text}`, () => assert.equal(payByIn(text), "own"));
  }

  for (const text of ["use payment link", "send a link", "pay by card", "use the link"]) {
    it(`link: ${text}`, () => assert.equal(payByIn(text), "link"));
  }

  for (const text of ["invoice John $500 for logo design", "paypal fees", "make it 400k", "due oct 1st"]) {
    it(`neither: ${text}`, () => assert.equal(payByIn(text), null));
  }
});

describe("as a correction", () => {
  it("on its own", () => {
    assert.equal(readCorrection("use my paypal details", today)?.payBy, "own");
  });
  it("with another change", () => {
    const got = readCorrection("make it $400 and use payment link", today);
    assert.equal(got?.payBy, "link");
  });
});
