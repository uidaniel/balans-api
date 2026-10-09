/**
 * "Try Balans" where a client has just seen an invoice paid (9 October
 * 2026): the paid invoice page and the receipt email, for a Free sender's
 * client only. Never by WhatsApp, and never under a Pro sender's name.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("./page.ts", import.meta.url), "utf8");
const email = readFileSync(new URL("../email/paid-delivery.ts", import.meta.url), "utf8");

describe("try Balans, after a payment", () => {
  it("is under 'Paid in full' on a Free sender's page only", () => {
    assert.match(page, /Paid in full\. Nothing more to do\.<\/div>\$\{doc\.plan === "pro" \? "" : tryBalans\(\)\}/);
    assert.match(page, /Get paid like this\. Send invoices on WhatsApp in seconds\./);
  });
  it("is in a Free sender's receipt email, HTML and text", () => {
    assert.equal((email.match(/d\.plan === "pro"\s*\?\s*""/g) ?? []).length, 2);
    assert.match(email, /utm_medium=receipt_email/);
  });
  it("is never sent by WhatsApp", () => {
    const wa = readFileSync(new URL("./client-whatsapp.ts", import.meta.url), "utf8");
    assert.doesNotMatch(wa, /Try Balans/i);
  });
});
