/**
 * The draft receipt, and the promise it has to keep.
 *
 * Drawing the draft is an improvement to the most-read message in the
 * product. It is also the first time that message depends on a subprocess and
 * a network call — Chrome on a 2GB box that is already rendering PDFs, and an
 * upload to Meta. Both can fail, and the draft is the last thing between a
 * number somebody typed and an invoice their client sees.
 *
 * So the tests that matter here are not about the picture. They are about
 * what happens when there isn't one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { receiptHtml, CARD } from "./receipt-card.ts";
import { payout } from "./summary.ts";
import { fontFaces } from "../pdf/fonts.ts";
import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import type { Draft } from "./store.ts";

const N = (naira: number) => naira * 100;
const today = { y: 2026, m: 9, d: 23 };

const draft = (over: Partial<Draft>): Draft =>
  ({
    id: "d1",
    clientId: "c1",
    type: "invoice",
    clientName: "Daniel",
    clientEmail: null,
    lines: [{ description: "3d design", qty: 1, unitAmountKobo: N(20_000) }],
    dueDate: { y: 2026, m: 9, d: 25 },
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    subtotalKobo: N(20_000),
    vatKobo: 0,
    totalKobo: N(20_000),
    number: 7,
    publicToken: "tok",
    ...over,
  }) as Draft;

/*
 * Priced abroad: the one kind of invoice that still goes through a processor
 * (a card, through Paystack), so the one whose fees the card itemises. A
 * naira invoice is paid straight to the sender's account and has none.
 */
const ABROAD: Partial<Draft> = {
  foreign: { currency: "USD", amountMinor: 1_507, rate: 1_327.2, source: "open.er-api.com", fetchedAt: "2026-09-24T06:00:00.000Z" },
};

describe("what the receipt says", () => {
  it("pays a naira invoice straight to the bank, with nothing taken", () => {
    // No processor touches it (bank-details.ts): no Monnify fee, no Balans
    // fee, and no "settles tonight" about a transfer we never see.
    const html = receiptHtml(draft({}), "free", today);
    assert.match(html, /To your bank/);
    assert.ok(html.includes("₦20,000"), "all of it lands");
    assert.ok(!/Monnify|Balans fee|tonight/.test(html), "a payment path this invoice does not take");
  });

  it("itemises the two fees instead of adding them up", () => {
    // The whole reason for the card. One number called "fees" would hide the
    // only line Pro changes.
    const html = receiptHtml(draft(ABROAD), "free", today);
    assert.match(html, /Paystack fee/);
    assert.match(html, /Balans fee \(Free\)/);
    assert.match(html, /To your bank/);
  });

  describe("an invoice priced abroad", () => {
    /*
     * Found on a phone, on a real $150 invoice: the card said "Monnify fee"
     * and promised settlement at 10 PM tonight, while the words directly
     * underneath the same picture said 1 to 2 business days.
     *
     * The fee *figure* was right the whole time — `payout` knew it was an
     * international card — so nothing here was arithmetic. The card simply
     * did not know the invoice was foreign, and said three confident things
     * about somebody's money on that basis.
     */
    const abroad = draft({
      subtotalKobo: N(199_031),
      vatKobo: 1_492_733,
      totalKobo: 21_395_833,
      // The rate the $150 was converted at: ₦199,031 ÷ 150. It was written
      // here as 1,426.39 once, which is the total with VAT divided by the
      // price without it — the same mistake the card itself was making.
      foreign: { currency: "USD", amountMinor: 15_000, rate: 1_326.873333, source: "open.er-api.com", fetchedAt: "2026-09-24T06:00:00.000Z" },
    });
    const html = receiptHtml(abroad, "pro", today);

    it("names the company that is actually charging the fee", () => {
      // 3.9% + ₦100 is not a Monnify price, and this is the line somebody
      // checks their bank statement against.
      assert.match(html, /Paystack fee/);
      assert.ok(!html.includes("Monnify fee"), "a correct number under the wrong name");
    });

    it("never promises a card will settle tonight", () => {
      // Section 9, in as many words. Monnify's 10 PM run is a promise we can
      // make because we know the hour of it; this is a card on somebody
      // else's schedule.
      assert.ok(!/10 PM|tonight|including weekends/i.test(html), "Monnify's promise on a card");
      assert.ok(html.includes(defaults.international.settlementText), "the configured sentence");
    });

    it("sets the agreed total beside the naira it is charged as", () => {
      // $150 plus 7.5% VAT is $161.25, which is the ₦213,958.33 beside it.
      // The card used to set the bare $150 there: two different amounts
      // presented as the same one.
      assert.match(html, /\$161\.25/);
      assert.match(html, /₦213,958\.33/);
      assert.ok(!html.includes("$150.00"), "the price before VAT, beside a total with it");
    });

    it("says the rate the invoice was locked at, not one worked back from VAT", () => {
      assert.match(html, /\$1 → ₦1,326\.87/);
    });

    it("still takes its figures from payout", () => {
      const { processorFeeKobo, receivesKobo } = payout(abroad, "pro");
      /*
       * ₦8,444.38, which is what the phone showed — 3.9% of ₦213,958.33
       * plus the flat ₦100, and the figure that was correct all along.
       *
       * The point of pinning it is the second line: Monnify caps at ₦2,000,
       * so a card fee four times that cap under Monnify's name was not a
       * rounding difference, it was a different company's price list.
       */
      assert.equal(processorFeeKobo, 844_438);
      assert.ok(processorFeeKobo > 200_000, "nowhere near Monnify's cap");
      assert.ok(html.includes(`−₦${(processorFeeKobo / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`));
      assert.ok(html.includes(formatNaira(receivesKobo)), "what lands in the bank");
    });
  });

  it("names the plan the user is actually on, and its figure", () => {
    // The same invoice, and the fee Pro does not take.
    const pro = receiptHtml(draft(ABROAD), "pro", today);
    assert.match(pro, /Balans fee \(Pro\)/);
    assert.match(pro, /₦0/);
    assert.ok(payout(draft(ABROAD), "pro").receivesKobo > payout(draft(ABROAD), "free").receivesKobo);
  });

  it("does not print the invoice total twice", () => {
    // "Client pays" only earns its line when fees are passed on and it is a
    // different figure from the invoice.
    assert.ok(!receiptHtml(draft(ABROAD), "free", today).includes("Client pays"));
    assert.match(receiptHtml(draft({ ...ABROAD, passFeesToClient: true }), "free", today), /Client pays/);
  });

  it("carries the payment plan with its dates", () => {
    const html = receiptHtml(draft({ depositPercent: 50 }), "free", today);
    assert.match(html, /50% deposit/);
    assert.match(html, /due Fri, 25 Sep/);
  });

  it("escapes a client who types angle brackets", () => {
    // It is interpolated into HTML that Chrome executes.
    const html = receiptHtml(draft({ clientName: '<img src=x onerror="alert(1)">' }), "free", today);
    assert.ok(!html.includes("<img src=x"), "a name is text, not markup");
    assert.match(html, /&lt;img/);
  });

  it("says what the card is, and still says who it is for", () => {
    // The heading names the job the picture does. The client did not stop
    // mattering, so the name moves to the line under it rather than off.
    const html = receiptHtml(draft({}), "free", today);
    assert.match(html, /<h1>Invoice breakdown<[/]h1>/);
    assert.match(html, /For Daniel/);
    assert.match(receiptHtml(draft({ type: "quote" }), "free", today), /<h1>Quote breakdown</);
  });

  it("carries the logo above the heading", () => {
    const html = receiptHtml(draft({}), "free", today);
    const mark = html.indexOf('class="mark"');
    assert.ok(mark > -1, "the logo block is there");
    assert.ok(mark < html.indexOf("<h1>"), "and it comes first");
    // Inlined, never linked: a render has no network, so a logo that arrives
    // as a second request is a logo that does not arrive.
    assert.ok(!/<img[^>]+logo/i.test(html), "no fetch for the mark");
  });

  it("is set in the brand's own type, carried with the render", () => {
    /*
     * The whole point of embedding. Without the faces the card comes back in
     * whatever the container has — DejaVu — which is the exact drift that
     * made the PDFs stop looking like balans.ng.
     */
    const html = receiptHtml(draft({}), "free", today);
    assert.match(html, /@font-face/);
    assert.match(html, /font-family:"Geist"/);
    assert.match(html, /data:font\/ttf;base64,/);
    assert.match(html, /font-family:"Geist","Instrument Sans"/, "Geist leads the stack");
  });

  it("has a text weight to be set in, not just headline weights", () => {
    // Geist carried only 700 and 800 while it was a headline face. Asking for
    // 400 from a family with none would have been answered by Bold, and every
    // word on the card would have come out heavy.
    assert.match(fontFaces(["display"]), /font-weight:400/);
  });

  it("is square, so nothing has to guess how it will be cropped", () => {
    assert.match(receiptHtml(draft({}), "free", today), new RegExp(`width:${CARD}px`));
  });
});

describe("when the picture cannot be drawn", () => {
  /*
   * Read from the source. The failure path only runs when Chrome or Meta is
   * broken, which no unit test can arrange honestly — but the shape of the
   * code is the guarantee, and the shape is what is asserted.
   */
  const card = readFileSync(new URL("./receipt-card.ts", import.meta.url), "utf8");
  const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");
  const branch = handle.slice(
    handle.indexOf('case "save_draft"'),
    handle.indexOf('case "send_document"'),
  );

  it("returns null rather than throwing", () => {
    // A draft lost to a busy browser would be the worst trade this change
    // could make.
    assert.match(card, /catch \(e\)/, "the render is wrapped");
    assert.match(card, /return null;/);
    assert.match(card, /Promise<string \| null>/);
  });

  it("still sends the draft, with the fees back in the words", () => {
    /*
     * The summary drops its PS line only when a card is going out. If the
     * card is null the PS returns, so the fee figure is never missing from
     * both places at once.
     */
    assert.match(branch, /draftCard\(/);
    assert.match(branch, /draftSummary\(draft, ctx\.today, gate\.plan, card === null\)/);
  });

  it("puts the words in the message either way", () => {
    // The card is a header above the summary, never instead of it: a picture
    // cannot be searched in a chat or read aloud.
    const pushed = branch.indexOf("extra.push(draftSummary(");
    assert.ok(pushed > -1, "the summary always goes out");
    assert.match(branch, /if \(card\) buttonsImage = card;/);
  });

  it("never draws one for a sample", () => {
    // A demonstration invoice with nobody's money in it, and the card is
    // entirely about where money goes.
    assert.match(card, /draft\.type === "sample"/);
  });
});
