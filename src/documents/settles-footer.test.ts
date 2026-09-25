/**
 * When the money lands, said once and said in the picture.
 *
 * It used to be in two places at once — small grey type at the bottom of the
 * breakdown card, and again as a line of text under it — so neither was the
 * answer to the one question somebody has before pressing send. And the naira
 * version was a fixed sentence about Monnify's 10 PM run, which is true at
 * noon and a lie at 11 PM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { settlesLine } from "../payments/settlement.ts";
import { draftSummary } from "./summary.ts";

/** An instant at a given Lagos hour. Lagos is UTC+1 all year. */
const atLagos = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 24, hour - 1, minute));

describe("the sentence about settlement", () => {
  it("says tonight right up to the run, and tomorrow from it", () => {
    /*
     * The boundary belongs to the later side. 22:00 has not beaten the run,
     * and telling somebody their money arrives tonight when it arrives
     * tomorrow is the one error here that costs trust.
     */
    assert.equal(settlesLine(atLagos(9)), "Settles tonight by 10pm");
    assert.equal(settlesLine(atLagos(21, 59)), "Settles tonight by 10pm");
    assert.equal(settlesLine(atLagos(22)), "Settles tomorrow by 10pm");
    assert.equal(settlesLine(atLagos(23, 30)), "Settles tomorrow by 10pm");
    assert.equal(settlesLine(atLagos(0, 1)), "Settles tonight by 10pm");
  });

  it("names the hour rather than leaving the reader to guess it", () => {
    // "Settles tonight" alone invites somebody to supply their own idea of
    // tonight, and refresh their banking app at eleven.
    assert.match(settlesLine(atLagos(9)), /by 10pm/);
  });

  it("never says tonight about a card", () => {
    /*
     * Section 9, word for word. Monnify's run is a promise we can make
     * because we know the hour of it; Paystack's schedule is somebody else's
     * and nobody has confirmed it in writing.
     */
    for (const h of [9, 21, 22, 23]) {
      const line = settlesLine(atLagos(h), "paystack");
      assert.ok(!/tonight|tomorrow/i.test(line), `"${line}" promises a Monnify hour for a card`);
    }
  });
});

describe("where it is said", () => {
  const card = readFileSync(new URL("./receipt-card.ts", import.meta.url), "utf8");

  it("is the footer of the card, not a footnote on it", () => {
    assert.match(card, /class="settles"/);
    // Only a card settles on a processor's clock now; a naira invoice is a
    // transfer straight to the sender's account (bank-details.ts).
    assert.match(card, /settlesLine\(new Date\(\), "paystack"\)/);
  });

  it("is set to be read at a glance", () => {
    // The old one was 26px at half opacity, which is what a disclaimer looks
    // like. This is the answer to the question, so it is sized like one.
    const rule = card.slice(card.indexOf(".settles {"), card.indexOf(".settles span"));
    assert.match(rule, /font-size:32px/);
    assert.match(rule, /font-weight:700/);
    assert.ok(!/opacity/.test(rule), "the line is faded again");
  });

  it("computes the hour rather than hard-coding the old sentence", () => {
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
