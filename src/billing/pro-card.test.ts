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
 * The card sits above the message rather than replacing it. Somebody with
 * images turned off, or on a client that will not load one, still gets the
 * whole offer in words — which is also why a card that fails to send does
 * not take the message down with it.
 *
 * And because a card is a picture, its claims are the only ones in the
 * product no test can read. "₦4,000" and "8 designs" are painted on. If the
 * config moves, the artwork is silently wrong and nothing fails. The last
 * block fails instead, and says which file to redraw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { proOffer, proOfferButtons } from "./messages.ts";
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

describe("the Pro message", () => {
  it("still says everything it said before the card existed", () => {
    // The card goes above these words, it does not replace them. Somebody
    // with images turned off, or on a client that will not load one, still
    // gets the whole offer.
    const words = proOffer(2);
    assert.match(words, /4,000/, "the price");
    assert.match(words, /Unlimited invoices/);
    assert.match(words, /logo on every invoice/);
    assert.match(words, /invoice designs/);
  });

  it("carries one button, and it is the way in", () => {
    const buttons = proOfferButtons();
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.id, "pay now", "the phrase the parser already reads");
  });
});

describe("when the card cannot be sent", () => {
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
