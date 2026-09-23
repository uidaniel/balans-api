/**
 * The three drawn things and the page behind them.
 *
 * The rule every one of these exists to hold: a card REPLACES nothing. A
 * picture cannot be searched in a chat, copied, or read aloud; Chrome can
 * fail and Meta can refuse an upload. So each card is an addition to the
 * words, and each renderer returns null rather than throwing when it cannot
 * be drawn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { owedHtml } from "./owed-card.ts";
import { periodHtml } from "./period-card.ts";
import { renderSummary, type SummaryData } from "./summary-page.ts";
import type { Civil } from "../../core/dates.ts";

const TODAY: Civil = { y: 2026, m: 9, d: 23 };

const debt = (over: Partial<Record<string, unknown>> = {}) => ({
  number: 2,
  clientName: "Edidiong Uwak",
  outstandingKobo: 1_254_525_00,
  dueDate: { y: 2026, m: 9, d: 17 } as Civil | null,
  daysLate: 6 as number | null,
  status: "sent",
  ...over,
});

const owed = (over: object = {}) => ({
  rows: [debt()],
  totalKobo: 1_254_525_00,
  more: 0,
  moreKobo: 0,
  ...over,
});

describe("the card for what people owe you", () => {
  it("leads with how much of it is already late", () => {
    /*
     * The list buried this. A total says how much is outstanding; the late
     * figure says how much is a problem, and that is the only question
     * anybody opens /owed to answer.
     */
    const html = owedHtml(owed() as never, TODAY);
    assert.match(html, /class="late">₦1,254,525 of it is already late/);
  });

  it("says so plainly when nothing is late", () => {
    const html = owedHtml(
      owed({ rows: [debt({ daysLate: null, dueDate: { y: 2026, m: 9, d: 29 } })] }) as never,
      TODAY,
    );
    assert.match(html, /None of it is late yet/);
    assert.ok(!html.includes("already late"));
  });

  it("stops at six and points at the page for the rest", () => {
    // More than six stops being a picture somebody reads at a glance and
    // becomes a table they squint at. The page lists every one.
    const many = owed({
      rows: Array.from({ length: 9 }, (_, i) => debt({ clientName: `Client ${i}` })),
      more: 2,
    });
    const html = owedHtml(many as never, TODAY);
    assert.equal(html.match(/class="who"/g)?.length, 6);
    assert.match(html, /and 5 more — tap View Summary/);
  });

  it("escapes a client's name rather than trusting it", () => {
    // A client name is typed by a user and rendered into HTML that Chrome
    // executes. Nothing else on this card comes from outside.
    const html = owedHtml(owed({ rows: [debt({ clientName: "<script>x</script>" })] }) as never, TODAY);
    assert.ok(!html.includes("<script>x"));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("the card for a month", () => {
  const month = (over: object = {}) => ({
    period: { label: "This month", from: TODAY, to: TODAY },
    documents: 2,
    paidKobo: 0,
    invoicedKobo: 1_953_275_00,
    outstandingKobo: 1_953_275_00,
    overdueKobo: 0,
    topClients: [],
    ...over,
  });

  it("leads with what is waiting when nothing has been paid", () => {
    /*
     * "Paid: ₦0" as the biggest number on the card is true and useless in a
     * month where nearly two million went out. It reads as nothing happened,
     * and something did.
     */
    const html = periodHtml(month() as never);
    assert.match(html, /class="big">₦1,953,275/);
    assert.match(html, /Waiting to be paid/);
  });

  it("leads with what landed once something has", () => {
    const html = periodHtml(month({ paidKobo: 800_000_00 }) as never);
    assert.match(html, /class="big">₦800,000/);
    assert.match(html, /Paid to you/);
  });

  it("is marigold, so it is not mistaken for an invoice", () => {
    // The draft receipt is cream and looks like paper. This is a report, and
    // the two are only ever compared scrolled back in a chat.
    assert.match(periodHtml(month() as never), /background:#F5B82E/);
  });
});

describe("the summary page", () => {
  const data = (over: Partial<SummaryData> = {}): SummaryData => ({
    businessName: "Daniel Studio",
    invoicesSent: 14,
    paidKobo: 4_250_000_00,
    outstandingKobo: 1_953_275_00,
    overdueKobo: 1_254_525_00,
    months: ["Jul", "Aug", "Sep"].map((label, i) => ({
      label,
      paidKobo: [930_000_00, 0, 500_000_00][i]!,
    })),
    owing: [
      {
        clientName: "Edidiong Uwak",
        ref: "BL-0002",
        number: 2,
        outstandingKobo: 1_254_525_00,
        dueDate: { y: 2026, m: 9, d: 17 },
        daysLate: 6,
      },
    ],
    clients: [{ name: "Opay Nigeria", paidKobo: 2_100_000_00 }],
    ...over,
  });

  it("fetches nothing it could fail without", () => {
    /*
     * It opens in WhatsApp's web view on whatever connection the chat
     * arrived over. The charts are inline SVG for that reason. The brand
     * fonts are the one request, from our own origin and with swap, so a
     * slow connection reads the page in the phone's font rather than staring
     * at a blank screen.
     */
    const html = renderSummary(data(), TODAY);
    assert.ok(!/<script/i.test(html), "no script at all");
    assert.ok(!/https?:\/\//i.test(html), "nothing is fetched from another origin");
    assert.match(html, /font-display:swap/);
    assert.match(html, /<svg class="bars"/);
  });

  it("keeps itself out of search engines", () => {
    // A link pasted anywhere is a link a crawler may follow, and this page is
    // one person's entire earnings.
    assert.match(renderSummary(data(), TODAY), /name="robots" content="noindex,nofollow"/);
  });

  it("draws a month with no money as a gap, not as a missing month", () => {
    // Dropping the empty month would compress the gap out of existence and
    // make a quiet quarter look busy.
    const html = renderSummary(data(), TODAY);
    assert.equal(html.match(/<rect /g)?.length, 2, "two bars for three months");
    assert.equal(html.match(/<span>(Jul|Aug|Sep)<\/span>/g)?.length, 3, "three labels");
  });

  it("says so rather than drawing an empty chart", () => {
    const html = renderSummary(
      data({ months: [{ label: "Sep", paidKobo: 0 }], paidKobo: 0 }),
      TODAY,
    );
    assert.match(html, /No payments yet/);
    assert.ok(!html.includes("<rect "));
  });

  it("renders for somebody who has done nothing yet", () => {
    // The first thing a new user sees if they tap the button, and the easiest
    // page in any product to divide by zero on.
    const html = renderSummary(
      data({
        invoicesSent: 0,
        paidKobo: 0,
        outstandingKobo: 0,
        overdueKobo: 0,
        months: [{ label: "Sep", paidKobo: 0 }],
        owing: [],
        clients: [],
      }),
      TODAY,
    );
    assert.match(html, /Nobody owes you anything right now/);
    assert.ok(!html.includes("NaN"), html.slice(0, 400));
    assert.ok(!html.includes("Infinity"));
  });

  it("escapes what a user typed", () => {
    const html = renderSummary(data({ businessName: "<img src=x onerror=1>" }), TODAY);
    assert.ok(!html.includes("<img src=x"));
    assert.match(html, /&lt;img/);
  });
});
