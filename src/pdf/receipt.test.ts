/**
 * The receipt, as its own document.
 *
 * It used to be the Classic invoice layout with one word changed, which got
 * two things wrong. An invoice argues for itself — here is the work, the
 * rate, the total, the date you owe it — and a receipt argues nothing,
 * because the money has already moved. And an invoice is a page somebody
 * files, while a receipt arrives into a chat seconds after paying and is read
 * on a phone.
 *
 * The figures are the part that has to be right. A receipt is proof of one
 * transfer, and the document it belongs to has a running total of its own;
 * mixing the two produced a slip that disagreed with the invoice it was
 * issued against.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderReceiptHtml } from "./receipt.ts";
import { renderDocumentHtml, type DocumentData } from "./template.ts";

const doc = (over: Partial<DocumentData> = {}): DocumentData => ({
  variant: "receipt",
  number: 2,
  ref: "BL-0002",
  businessName: "pysav",
  businessEmail: "hello@pysav.ng",
  businessAddress: null,
  businessTin: null,
  logoDataUri: null,
  clientName: "danny",
  clientEmail: null,
  lines: [{ description: "Web dev", qty: 1, unitAmountKobo: 200_000_00, amountKobo: 200_000_00 }],
  subtotalKobo: 200_000_00,
  vatKobo: 15_000_00,
  vatPercent: 7.5,
  totalKobo: 215_000_00,
  // What the document has been credited with, across every payment.
  amountPaidKobo: 53_750_00,
  issueDate: { y: 2026, m: 9, d: 23 },
  dueDate: { y: 2026, m: 10, d: 8 },
  notes: null,
  publicUrl: null,
  legalLines: ["Issued by pysav via Balans", "Payments processed by Monnify"],
  showMadeWith: false,
  receipt: {
    number: 1,
    paidOn: { y: 2026, m: 9, d: 24 },
    method: "ACCOUNT_TRANSFER",
    reference: "bal_3a417e9a6c6c4592_9f31ab20",
    // What this one transfer was: the stage, grossed up because this invoice
    // passes the processor's cut to the client.
    amountKobo: 54_670_06,
  },
  ...over,
});

describe("what a receipt says", () => {
  it("leads with what the client actually transferred", () => {
    /*
     * ₦54,670.06, not ₦53,750. The stage is what settles the invoice; the
     * grossed-up figure is what left their account and what they will look
     * for on their bank statement, which is the whole use of a receipt.
     */
    const html = renderReceiptHtml(doc());
    assert.match(html, /<p class="big">₦54,670\.06<\/p>/);
  });

  it("works out what is still owed from the invoice, not from this payment", () => {
    /*
     * The trap. Subtracting the grossed-up payment from the invoice total
     * gives ₦160,329.94 — a figure that appears nowhere else, disagrees with
     * the payment plan, and is wrong by exactly the processor's cut.
     */
    const html = renderReceiptHtml(doc());
    assert.match(html, /Still owed/);
    assert.match(html, /₦161,250/);
    assert.ok(!html.includes("160,329"), "the surcharge was subtracted from the invoice");
  });

  it("says nothing about a balance once there is none", () => {
    // "Paid ₦215,000 of ₦215,000, ₦0 still owed" is three lines saying what
    // the figure at the top already said.
    const settled = renderReceiptHtml(
      doc({ amountPaidKobo: 215_000_00, receipt: { ...doc().receipt!, amountKobo: 215_000_00 } }),
    );
    assert.ok(!settled.includes("Still owed"));
    assert.ok(!settled.includes("Invoice total"));
  });

  it("answers how much, when, and against what", () => {
    const html = renderReceiptHtml(doc());
    assert.match(html, /Thu, 24 Sep/, "when");
    assert.match(html, /Receipt<\/span>.*?#1/s);
    assert.match(html, /Invoice<\/span>.*?#2/s);
    assert.match(html, /Bank transfer/, "how it was paid");
    assert.match(html, /bal_3a417e9a6c6c4592_9f31ab20/, "and the reference support would ask for");
  });

  it("carries the business, and the two lines section 12 requires", () => {
    const html = renderReceiptHtml(doc());
    assert.match(html, /pysav/);
    assert.match(html, /Issued by pysav via Balans/);
    assert.match(html, /Payments processed by Monnify/);
  });
});

describe("what a receipt is not", () => {
  it("is not the invoice layout with a different word at the top", () => {
    const receipt = renderReceiptHtml(doc());
    const invoice = renderDocumentHtml(doc({ variant: "invoice" }));

    // The invoice sets the work as a ruled table with a header row. The slip
    // sets it as labels and leader dots, which is a different document.
    assert.match(invoice, /class="items"/);
    assert.ok(!receipt.includes('class="items"'), "the billing table is back");
    assert.match(receipt, /class="slip"/);
    assert.match(receipt, /class="ln /, "label, leaders, figure");
  });

  it("is never stamped PAID, because the whole page already says so", () => {
    // `isPaid` covers only invoices. A stamp here says the same thing twice.
    assert.ok(!renderReceiptHtml(doc()).includes('class="paid"'));
    assert.match(renderReceiptHtml(doc()), /class="stamp"/, "the quiet one instead");
  });

  it("is torn off, with a point per tooth rather than a row of battlements", () => {
    /*
     * Mirrored background gradients are the usual trick for this and they
     * produce squared castellations: a sawtooth needs its points on the
     * diagonal of each tile, which a gradient only gives when the tile is
     * square. So the shape is generated instead.
     */
    const html = renderReceiptHtml(doc());
    assert.match(html, /clip-path:polygon\(/);
    const points = /clip-path:polygon\(([^)]*\))*[^;]*/.exec(html)?.[0] ?? "";
    assert.ok(points.split("%").length > 30, "too few points to be a tear");
    assert.ok(!html.includes("repeat-x"), "the gradient version is back");
  });

  it("is one design, not one of the eight", () => {
    /*
     * A freelancer chooses how their invoices look, because that is their
     * document going out under their name. A receipt is proof of a payment
     * and there is nothing about it to choose — which also means there is one
     * of these to get right rather than eight.
     */
    const pdf = readFileSync(new URL("../documents/pdf.ts", import.meta.url), "utf8");
    const render = pdf.slice(pdf.indexOf("export async function renderReceiptPdf"));
    assert.match(render, /renderReceiptHtml\(doc\)/);
    assert.ok(!/renderTemplate\(/.test(render.slice(0, render.indexOf("export "))));
  });
});
