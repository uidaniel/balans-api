/**
 * Two Pro cards, and the reason there are two.
 *
 * One is headed "Upgrade to Pro." and is true whoever is reading it. It goes
 * out whenever somebody asks for Pro.
 *
 * The other is headed "Five done. Go unlimited." — a statement of fact about
 * somebody who has used all five — so it belongs only on the message that
 * says they have run out. Showing it to a person on their second invoice
 * would be a false claim in the one message whose whole job is to be trusted
 * about money. Swapping the two is the mistake this file exists to catch.
 *
 * The other half is what the captions may say. A card carries the price, the
 * feature list and the promise that nothing is lost on cancelling; a caption
 * printed under it that repeats any of that is the same pitch twice in one
 * bubble, and the copy on the picture is the one people read.
 *
 * And because a card is a picture, its claims are the only ones in the
 * product no test can read. "₦4,000" and "8 designs" are painted on. If the
 * config moves, the artwork is silently wrong and nothing fails. The last
 * block fails instead, and says which file to redraw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { proOffer, proOfferCaption, proOfferButtons } from "./messages.ts";
import { LIMIT_CARD, UPGRADE_CARD } from "../conversation/machine.ts";
import { defaults } from "../config.ts";
import { availableTo } from "../pdf/templates.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const limit = defaults.plans.free.documentsPerMonth!;

describe("the two Pro cards", () => {
  it("are two different pictures", () => {
    assert.notEqual(LIMIT_CARD, UPGRADE_CARD, "or one of the two headlines is wrong somewhere");
  });

  it("are both served by the brand route", () => {
    // A URL Meta cannot fetch is a message that fails to send at all.
    const route = read("../http/routes/brand.ts");
    for (const url of [LIMIT_CARD, UPGRADE_CARD]) {
      assert.match(url, /^https?:\/\//, "Meta fetches these by URL");
      assert.match(route, new RegExp(`"${url.split("/").pop()}":`));
    }
  });

  it("go on the right messages", () => {
    const handle = read("../conversation/handle.ts");

    // The limit card belongs to the limit message and nothing else.
    const limitFn = handle.slice(handle.indexOf("async function limitCard("));
    assert.match(limitFn.slice(0, 1600), /LIMIT_CARD/, "the limit message keeps 'Five done'");

    // The upgrade screen gets the one that is true for everybody.
    const upgrade = handle.slice(handle.indexOf('case "show_upgrade"'));
    assert.match(upgrade.slice(0, 1400), /UPGRADE_CARD/);
    assert.doesNotMatch(
      upgrade.slice(0, 1400),
      /LIMIT_CARD/,
      "'Five done' must not go to somebody who has not finished five",
    );
  });
});

describe("the Pro caption", () => {
  it("says how far through the month they are", () => {
    assert.match(proOfferCaption(2), new RegExp(`2 of your ${limit}`));
    assert.match(proOfferCaption(limit), new RegExp(`all ${limit}`), "and reads right at the end");
  });

  it("does not repeat what is already on the card", () => {
    for (const used of [0, 2, limit]) {
      const caption = proOfferCaption(used);
      for (const claim of [/logo/i, /designs/i, /reminders/i, /fee/i, /cancel/i, /4,000/]) {
        assert.doesNotMatch(caption, claim, `the picture above already says this (used ${used})`);
      }
    }
  });

  it("carries one button, and it is the way in", () => {
    const buttons = proOfferButtons();
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.id, "pay now", "the phrase the parser already reads");
  });
});

describe("when the card cannot be sent", () => {
  it("falls back to words that carry the offer on their own", () => {
    // The caption leans on the picture. Resending it alone would be a message
    // with the point missing, so the fallback is the full pitch.
    const words = proOffer(2);
    assert.match(words, /4,000/, "the price");
    assert.match(words, /Unlimited invoices/, "and what it buys");

    const handle = read("../conversation/handle.ts");
    const upgrade = handle.slice(handle.indexOf('case "show_upgrade"'), handle.length);
    assert.match(upgrade.slice(0, 1400), /buttonsFallback = proOffer\(used\)/);
  });

  it("retries in words rather than dropping the message", () => {
    const handle = read("../conversation/handle.ts");
    assert.match(
      handle,
      /if \(!res\.ok && withButtons && buttonsImage && !res\.outsideWindow\)/,
      "a picture that will not send should not take the message with it",
    );
  });
});

describe("what the cards have painted on them", () => {
  /*
   * Not assertions about the code. These are the values the artwork at
   * assets/brand/limit.png and assets/brand/upgrade.png was drawn around.
   * Changing one means redrawing them — this is here so that is a decision
   * somebody makes rather than something they hear from a customer.
   */
  it("still match the free document limit", () => {
    assert.equal(limit, 5, 'limit.png says "Five done" and "five documents a month"');
  });

  it("still match the Pro price", () => {
    assert.equal(defaults.plans.pro.priceKobo, 4_000_00, 'both cards say "₦4,000 a month"');
  });

  it("still match the number of designs", () => {
    assert.equal(availableTo("pro").length, 8, 'both cards say "8 invoice designs"');
  });

  it("still match the promise of no fee", () => {
    assert.equal(defaults.plans.pro.feePercentBps, 0, 'both cards say "No Balans fee"');
  });

  it("still match the word the upgrade card tells people to reply", () => {
    // upgrade.png says: Reply **pay**. It only said "pay now" before.
    const machine = read("../conversation/machine.ts");
    const fn = machine.slice(machine.indexOf("function asProChoice("));
    assert.match(fn.slice(0, 600), /\^\(pay\|/, 'a bare "pay" has to reach the payment link');
  });
});
