/**
 * The email that takes a document to its client, named as what it is.
 *
 * A payment request went out as "Invoice #0012 from Danny Codes Ltd" with
 * "has sent you an invoice" under it (14 October 2026). The client looks for
 * an invoice, and the sender gets asked about one they never made.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { documentWords } from "./client-delivery.ts";

const words = (type: string, number: string | null = "0012", title: string | null = null) =>
  documentWords({ type, number, title, business: "Danny Codes Ltd", price: "₦500,000", updated: false });

describe("what the client's email calls the document", () => {
  it("calls a payment request a payment request", () => {
    const w = words("payment_request");
    assert.equal(w.subject, "Payment request #0012 from Danny Codes Ltd — ₦500,000");
    assert.equal(w.heading, "Payment request #0012");
    assert.equal(w.sentYou, "Danny Codes Ltd has sent you a payment request.");
  });

  it("calls a quote a quote", () => {
    const w = words("quote", "0003");
    assert.equal(w.subject, "Quote #0003 from Danny Codes Ltd — ₦500,000");
    assert.equal(w.heading, "Quote #0003");
    assert.equal(w.sentYou, "Danny Codes Ltd has sent you a quote.");
  });

  it("leaves an invoice as it was", () => {
    const w = words("invoice");
    assert.equal(w.subject, "Invoice #0012 from Danny Codes Ltd — ₦500,000");
    assert.equal(w.heading, "Invoice #0012");
    assert.equal(w.sentYou, "Danny Codes Ltd has sent you an invoice.");
  });

  it("keeps the title and the missing number as before", () => {
    assert.equal(words("payment_request", null, "Website").subject, "Payment request: Website from Danny Codes Ltd — ₦500,000");
    assert.equal(words("payment_request", null).heading, "Payment request");
  });

  it("offers a quote to view, not to pay", () => {
    // Nothing on a quote can be paid: its button opens it, as it always has.
    const source = readFileSync(new URL("./client-delivery.ts", import.meta.url), "utf8");
    assert.match(source, /link && d\.type === "quote" \? button\("View quote", link\)/);
    assert.match(source, /link && d\.type !== "quote" \? button\(/);
  });
});
