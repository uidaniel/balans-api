/**
 * The pieces every document layout is built from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sheet } from "./kit.ts";
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
    legalLines: ["Issued by Studio", "Payments handled by Monnify"],
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
