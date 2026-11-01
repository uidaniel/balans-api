/**
 * The emailed statement (1 November 2026): which month a request means, and
 * what the sheet says. The queries are checked against a real database
 * separately; these are the parts that need none.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readPeriod } from "../../core/period.ts";
import { formatISO } from "../../core/dates.ts";
import { statementHtml, statementPeriod, wholeMonth, type Statement } from "./statement.ts";
import { NAME_IS_RIGHT, STATEMENT } from "../conversation/machine.ts";

const NOV_1 = { y: 2026, m: 11, d: 1 };

describe("which month a statement covers", () => {
  it("is the month just gone when none is named", () => {
    const p = statementPeriod("email my statement", NOV_1, readPeriod);
    assert.equal(formatISO(p.from), "2026-10-01");
    assert.equal(formatISO(p.to), "2026-10-31");
    assert.equal(p.label, "October");
  });

  it("is the month on the button, however late it is tapped", () => {
    const p = statementPeriod("email statement 2026-09", { y: 2026, m: 11, d: 20 }, readPeriod);
    assert.equal(formatISO(p.from), "2026-09-01");
    assert.equal(formatISO(p.to), "2026-09-30");
    assert.equal(p.label, "September");
  });

  it("crosses the new year", () => {
    const p = statementPeriod("email my statement", { y: 2027, m: 1, d: 1 }, readPeriod);
    assert.equal(formatISO(p.from), "2026-12-01");
    assert.equal(formatISO(p.to), "2026-12-31");
  });

  it("is a whole month even when a week is named", () => {
    const p = wholeMonth({ y: 2028, m: 2, d: 17 });
    assert.equal(formatISO(p.from), "2028-02-01");
    assert.equal(formatISO(p.to), "2028-02-29");
    assert.equal(p.label, "February");
  });
});

describe("asking for it", () => {
  for (const said of [
    "email statement 2026-10",
    "Email my statement",
    "send me my monthly report",
    "statement",
    "my statement",
    "email my statement for september",
  ]) {
    it(`reads "${said}"`, () => assert.ok(STATEMENT.test(said)));
  }

  for (const said of ["report", "summary", "statement of work for Zenith 200k", "Invoice Tunde 20k for statement design"]) {
    it(`leaves "${said}" alone`, () => assert.ok(!STATEMENT.test(said)));
  }

  it("knows the name check's yes, tapped or typed", () => {
    for (const said of ["name is right", "Yes, that's it", "that's my business name", "keep it"]) {
      assert.ok(NAME_IS_RIGHT.test(said), said);
    }
    assert.ok(!NAME_IS_RIGHT.test("yes"));
  });
});

const SAMPLE: Statement = {
  businessName: "Ada & Co <Studio>",
  period: wholeMonth({ y: 2026, m: 10, d: 1 }),
  asOf: { y: 2026, m: 10, d: 31 },
  generated: NOV_1,
  openingKobo: 30_000_000,
  invoicedKobo: 145_000_000,
  receivedKobo: 110_000_000,
  closingKobo: 65_000_000,
  overdueKobo: 50_000_000,
  documents: [
    {
      issueDate: { y: 2026, m: 10, d: 3 },
      number: 2,
      type: "invoice",
      clientName: "Zenith Homes",
      what: "Duplex render",
      dueDate: { y: 2026, m: 10, d: 10 },
      totalKobo: 100_000_000,
      paidKobo: 100_000_000,
      currency: "NGN",
      originalMinor: null,
    },
    {
      issueDate: { y: 2026, m: 10, d: 12 },
      number: 3,
      type: "invoice",
      clientName: "Acme Ltd",
      what: null,
      dueDate: { y: 2026, m: 10, d: 20 },
      totalKobo: 45_000_000,
      paidKobo: 0,
      currency: "USD",
      originalMinor: 30_000,
    },
  ],
  payments: [
    { date: { y: 2026, m: 10, d: 8 }, clientName: "Zenith Homes", number: 2, type: "invoice", method: "Bank transfer", amountKobo: 100_000_000 },
    { date: { y: 2026, m: 10, d: 15 }, clientName: "Zenith Homes", number: 1, type: "invoice", method: "Marked paid", amountKobo: 10_000_000 },
  ],
  topInvoiced: [
    { name: "Zenith Homes", kobo: 100_000_000, count: 1 },
    { name: "Acme Ltd", kobo: 45_000_000, count: 1 },
  ],
  topPaid: [{ name: "Zenith Homes", kobo: 110_000_000 }],
  owing: [{ clientName: "Acme Ltd", number: 3, type: "invoice", outstandingKobo: 45_000_000, dueDate: { y: 2026, m: 10, d: 20 } }],
  avgDaysToPay: 5,
  collectedShare: 0.69,
  previous: { label: "September", receivedKobo: 20_000_000, invoicedKobo: 50_000_000 },
};

describe("the statement sheet", () => {
  const html = statementHtml(SAMPLE);

  it("leads with the four balances", () => {
    for (const k of ["Owed at the start", "Invoiced", "Money in", "Owed at the end"]) assert.ok(html.includes(k), k);
    assert.ok(html.includes("₦300,000"));
    assert.ok(html.includes("₦1,100,000"));
    assert.ok(html.includes("₦650,000"));
  });

  it("names the month and the business, escaped", () => {
    assert.ok(html.includes("October statement"));
    assert.ok(html.includes("Ada &amp; Co &lt;Studio&gt;"));
    assert.ok(!html.includes("<Studio>"));
  });

  it("lists every payment and every invoice, with the foreign amount under it", () => {
    assert.ok(html.includes("Invoice #2"));
    assert.ok(html.includes("Marked paid"));
    assert.ok(html.includes("$300.00"));
    assert.ok(html.includes("11 days late"));
  });

  it("ranks the clients both ways", () => {
    assert.ok(html.includes("Most invoiced"));
    assert.ok(html.includes("Paid you most"));
  });

  it("compares with the month before", () => {
    assert.ok(html.includes("▲ 450% on September"));
  });

  it("says so when a month had nothing", () => {
    const empty = statementHtml({ ...SAMPLE, documents: [], payments: [], owing: [], topInvoiced: [], topPaid: [] });
    assert.ok(empty.includes("No payments came in during October."));
    assert.ok(empty.includes("No invoices were issued in October."));
    assert.ok(empty.includes("Every invoice is paid."));
  });

  it("prints each total once, not on every page", () => {
    assert.ok(!html.includes("<tfoot"));
  });
});
