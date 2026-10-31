/**
 * The pieces every document layout is built from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasVat, sheet, sheetFontSize, sums, totals } from "./kit.ts";
import type { DocumentData } from "./template.ts";

/**
 * The support reference, in the corner of every layout.
 *
 * `number` is the invoice number the client reads and it restarts at 1 for
 * every freelancer, so it cannot answer "invoice 2 has not been paid" \u2014 that
 * names one invoice per user on the platform. The reference can, and it is
 * only useful if it is on the document somebody is holding.
 */
describe("the reference printed on a document", () => {
  const base: DocumentData = {
    variant: "invoice",
    number: 2,
    ref: "BL-0042",
    businessName: "Studio",
    businessEmail: null,
    businessAddress: null,
    businessTin: null,
    logoDataUri: null,
    clientName: "Daniel Uwak",
    clientEmail: null,
    lines: [{ description: "Logo", qty: 1, unitAmountKobo: 50_000_00, amountKobo: 50_000_00 }],
    subtotalKobo: 50_000_00,
    vatKobo: 0,
    vatPercent: null,
    totalKobo: 50_000_00,
    amountPaidKobo: 0,
    issueDate: { y: 2026, m: 9, d: 23 },
    dueDate: { y: 2026, m: 9, d: 30 },
    notes: null,
    publicUrl: null,
    legalLines: ["Issued by Studio", "Payments handled by Paystack"],
    showMadeWith: false,
  };

  const render = (d: DocumentData) => sheet(d, {}, { css: "", body: "<p>body</p>" });

  it("is not printed, since it counts every invoice on Balans", () => {
    // Taken off on 3 October 2026: the sender's own number is the one on
    // the sheet, and a second, platform-wide number beside it read as theirs.
    assert.ok(!render(base).includes("BL-0042"));
  });

  it("says nothing at all when there is none", () => {
    // Everything issued before references existed, and every sample.
    assert.ok(!render({ ...base, ref: null }).includes('class="ref"'));
    assert.ok(!render({ ...base, ref: undefined }).includes('class="ref"'));
  });

  it("cannot push a full page onto a second one", () => {
    // Absolutely positioned, so a layout that already fills the sheet is not
    // made one line taller by it.
    assert.match(render(base), /\.ref\{[^}]*position:absolute/);
  });
});

/**
 * Nothing cut off the bottom of the page (13 October 2026): a three-line
 * invoice with a project title and a signature lost its "Pay online at" line
 * to the page edge, because neither was counted.
 */
describe("fitting a document to the page", () => {
  const base: DocumentData = {
    variant: "invoice",
    number: 1,
    businessName: "Uwak",
    businessEmail: "uwak@example.com",
    businessAddress: null,
    businessTin: null,
    logoDataUri: null,
    clientName: "Blessing",
    clientEmail: null,
    lines: [
      { description: "Portfolio site design", qty: 1, unitAmountKobo: 450_000_00, amountKobo: 450_000_00 },
      { description: "Development", qty: 1, unitAmountKobo: 250_000_00, amountKobo: 250_000_00 },
      { description: "Hosting", qty: 1, unitAmountKobo: 100_000_00, amountKobo: 100_000_00 },
    ],
    subtotalKobo: 800_000_00,
    vatKobo: 0,
    vatPercent: null,
    totalKobo: 800_000_00,
    amountPaidKobo: 0,
    issueDate: { y: 2026, m: 10, d: 13 },
    dueDate: { y: 2026, m: 10, d: 20 },
    notes: null,
    publicUrl: "https://payment.balans.ng/i/abc",
    legalLines: ["Issued by Uwak.", "Payments go directly to the merchant's own bank account."],
    showMadeWith: false,
  };
  const mm = (d: DocumentData) => parseFloat(sheetFontSize(d));

  it("tells the renderer the sizes it may measure between", () => {
    const html = sheet(base, {}, { css: "", body: "" });
    const m = html.match(/data-fit="([\d.]+) ([\d.]+) ([\d.]+)"/);
    assert.ok(m, "every sheet carries its fitting range");
    const [min, max, flow] = m!.slice(1).map(Number) as [number, number, number];
    assert.ok(min < flow && flow < max);
  });

  it("leaves a short, plain invoice at full size", () => {
    assert.equal(mm(base), mm({ ...base, lines: base.lines.slice(0, 1) }));
  });

  it("counts a title, a signature and long terms", () => {
    const full = mm(base);
    const extras = mm({ ...base, title: "Website Portfolio Development", signatureDataUri: "data:image/png;base64,AA==" });
    assert.ok(extras < full, "a title and a signature are not free");
    const terms = mm({ ...base, notes: "Terms. ".repeat(70) });
    assert.ok(terms < mm({ ...base, notes: "Net 30." }), "five lines of terms cost more than one");
  });

  it("prints no VAT line on a document without VAT", () => {
    assert.equal(hasVat(base), false);
    const rendered = totals(base) + sums(base);
    assert.ok(!rendered.includes("VAT"), "VAT (0%) ₦0 reads as a tax somebody forgot");
    const vat = { ...base, vatKobo: 60_000_00, vatPercent: 7.5, totalKobo: 860_000_00 };
    assert.ok(totals(vat).includes("VAT (7.5%)"));
    assert.ok(sums(vat).includes("VAT (7.5%)"));
  });
});
