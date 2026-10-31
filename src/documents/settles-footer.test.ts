/**
 * When the money lands, said once and said in the picture.
 *
 * It used to be in two places at once — small grey type at the bottom of the
 * breakdown card, and again as a line of text under it — so neither was the
 * answer to the one question somebody has before pressing send.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { settlesLine } from "../payments/settlement.ts";
import { draftSummary } from "./summary.ts";

describe("the sentence about settlement", () => {
  it("never says tonight about a card", () => {
    /*
     * Section 9, word for word. Paystack's schedule is somebody else's and
     * nobody has confirmed it in writing, so there is no hour to promise.
     */
    const line = settlesLine();
    assert.ok(!/tonight|tomorrow/i.test(line), `"${line}" promises an hour for a card`);
  });
});

describe("where it is said", () => {
  const card = readFileSync(new URL("./receipt-card.ts", import.meta.url), "utf8");

  it("is the footer of the card, not a footnote on it", () => {
    assert.match(card, /class="settles"/);
    // Only a card settles on a processor's clock now; a naira invoice is a
    // transfer straight to the sender's account (bank-details.ts).
    assert.match(card, /settlesLine\(\)/);
  });

  it("is set to be read at a glance", () => {
    // The old one was 26px at half opacity, which is what a disclaimer looks
    // like. This is the answer to the question, so it is sized like one.
    const rule = card.slice(card.indexOf(".settles {"), card.indexOf(".settles span"));
    assert.match(rule, /font-size:32px/);
    // Medium in Onest since 29 October 2026: the brand sets nothing bolder.
    assert.match(rule, /font-weight:500/);
    assert.ok(!/opacity/.test(rule), "the line is faded again");
  });

  it("does not bring back the old fixed sentence", () => {
    assert.ok(
      !card.includes("the same day,"),
      "the fixed 'settles at 10 PM the same day' sentence is back",
    );
  });

  it("is not repeated in the words underneath", () => {
    /*
     * Said twice, neither is the answer. The card's version is the one that
     * can be read at a glance and forwarded as a picture.
     */
    const draft = {
      type: "invoice",
      clientName: "Acme",
      clientEmail: null,
      lines: [{ description: "Work", qty: 1, unitAmountKobo: 663_500_00 }],
      totalKobo: 663_500_00,
      subtotalKobo: 663_500_00,
      vatKobo: 0,
      vatPercent: null,
      depositPercent: null,
      instalments: null,
      passFeesToClient: false,
      notes: null,
      dueDate: { y: 2026, m: 10, d: 2 },
      foreign: { currency: "USD", amountMinor: 500_00, rate: 1327 },
    } as never;

    const out = draftSummary(draft, { y: 2026, m: 9, d: 24 }, "pro", false);
    assert.ok(!/Settles:/.test(out), "the draft text is answering it as well");
  });
});
