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

describe("what the receipt says", () => {
  it("shows the figure the words show, to the naira", () => {
    /*
     * The failure worth fearing from a second rendering of the same facts:
     * two surfaces disagreeing about money. Both read `payout`, so this is a
     * check that the card did not start doing its own arithmetic.
     */
    const d = draft({});
    const html = receiptHtml(d, "free", today);
    const { receivesKobo, processorFeeKobo, balansFeeKobo } = payout(d, "free");

    // ₦20,000 on Free: ₦400 to Monnify (1.5% + the flat ₦100) and ₦200 to
    // us. On Pro the same invoice lands ₦19,600, which is the figure Pro is
    // bought for and the next test checks.
    assert.ok(html.includes("₦19,400"), "what lands in the bank");
    assert.equal(receivesKobo, N(19_400));
    assert.ok(html.includes(`−₦${(processorFeeKobo / 100).toLocaleString("en-US")}`), "Monnify's cut");
    assert.ok(html.includes(`−₦${(balansFeeKobo / 100).toLocaleString("en-US")}`), "ours");
  });

  it("itemises the two fees instead of adding them up", () => {
    // The whole reason for the card. One number called "fees" would hide the
    // only line Pro changes.
    const html = receiptHtml(draft({}), "free", today);
    assert.match(html, /Monnify fee/);
    assert.match(html, /Balans fee \(Free\)/);
    assert.match(html, /To your bank/);
  });

  it("names the plan the user is actually on, and its figure", () => {
    // The same invoice, and the ₦200 Pro does not take.
    const pro = receiptHtml(draft({}), "pro", today);
    assert.match(pro, /Balans fee \(Pro\)/);
    assert.match(pro, /₦0/);
    assert.ok(pro.includes("₦19,600"), "Pro keeps what Free pays us");
    assert.equal(payout(draft({}), "pro").receivesKobo, N(19_600));
  });

  it("does not print the invoice total twice", () => {
    // "Client pays" only earns its line when fees are passed on and it is a
    // different figure from the invoice.
    assert.ok(!receiptHtml(draft({}), "free", today).includes("Client pays"));
    assert.match(receiptHtml(draft({ passFeesToClient: true }), "free", today), /Client pays/);
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
