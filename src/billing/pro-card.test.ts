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
 * product no test can read. "₦3,000" and "8 designs" are painted on. If the
 * config moves, the artwork is silently wrong and nothing fails. The last
 * block fails instead, and says which file to redraw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { PRO_PAY_FOOTER, proOffer, proPayLabel, proPayPrompt } from "./messages.ts";
import { LIMIT_CARD, UPGRADE_CARD, PRO_CARD } from "../conversation/machine.ts";
import { defaults } from "../config.ts";
import { availableTo } from "../pdf/templates.ts";
import { proCardHtml } from "./pro-cards.ts";

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
      assert.match(route, new RegExp(`"${url.split("/").pop()!.split("?")[0]}":`));
    }
  });

  it("go on the right messages", () => {
    const handle = read("../conversation/handle.ts");

    // The limit card belongs to the limit message and nothing else.
    const limitFn = handle.slice(handle.indexOf("async function limitCard("));
    assert.match(limitFn.slice(0, 1600), /LIMIT_CARD/, "the limit message keeps 'Five done'");

    /*
     * The upgrade screen gets the one that is true for everybody.
     *
     * Bounded by the next case rather than by a character count: the branch
     * grew and a fixed window stopped reaching the line it was checking, so
     * the test failed while the code was right.
     */
    const from = handle.indexOf('case "show_upgrade"');
    const upgrade = handle.slice(from, handle.indexOf('case "start_pro"', from));

    assert.ok(upgrade.length > 100, "the branch should be findable");
    assert.match(upgrade, /UPGRADE_CARD/);
    assert.doesNotMatch(
      upgrade,
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
    assert.match(words, /3,000/, "the price");
    assert.match(words, /Unlimited invoices/);
    assert.match(words, /logo on every invoice/);
    assert.match(words, /invoice designs/);
  });

  it("carries one button, saying the price, within Meta's limits", () => {
    assert.equal(proPayLabel(), `Pay ₦${(defaults.plans.pro.priceKobo / 100).toLocaleString("en-NG")}`);
    assert.ok(proPayLabel().length <= 20, "Meta refuses a longer button");
    assert.ok(PRO_PAY_FOOTER.length <= 60, "Meta refuses a longer footer");
  });
});

describe("the card reaching the message", () => {
  /*
   * The bug this block exists for.
   *
   * Setting `buttonsImage` in the effect is not the same as it arriving at
   * WhatsApp. There are two paths out of here — an ordinary inbound message
   * and a submitted Flow — each with its own call to `reply`, and for a
   * while only the Flow one passed the picture on. So "/pro" set the card
   * and then dropped it one function later, and every test passed, because
   * they all stopped at the branch that set it.
   */
  const handle = read("../conversation/handle.ts");

  it("is passed on by every path that answers a message", () => {
    const calls = handle.match(/await reply\([^;]*?\);/gs) ?? [];
    // Calls forwarding an outcome's buttons, not ones passing a literal set:
    // a literal has no card to lose.
    const forwarding = calls.filter((c) => /(buttons|outcome\.buttons)[,)]/.test(c));

    assert.ok(forwarding.length >= 2, "an ordinary message and a submitted form, at least");
    for (const call of forwarding) {
      assert.match(
        call.replace(/\s+/g, " "),
        /buttonsImage/,
        "this path forwards buttons but drops the card",
      );
    }
  });

  it("reaches the send call itself", () => {
    assert.match(
      handle,
      /sendButtons\(to, \{ body, buttons, headerImage: buttonsImage \}\)/,
      "the last step is the one that actually puts it on the message",
    );
  });

  it("is not put over a question the effect never asked", () => {
    // A card is the header of one specific message. If the machine's buttons
    // won, the message the card belongs above was never sent.
    assert.match(handle, /const buttonsImage = outcome\.buttons \? outcome\.buttonsImage : undefined;/);
  });
});

describe("the Pay button", () => {
  /*
   * A link button that opens Paystack's checkout in WhatsApp's browser.
   *
   * It was a reply button whose answer was an account number to copy into a
   * bank app, which only suited somebody paying by transfer. Since 26
   * September 2026 it opens the checkout, which offers card, transfer, USSD
   * and the rest on one page.
   */
  const handle = read("../conversation/handle.ts");
  const from = handle.indexOf('case "show_upgrade"');
  const offer = handle.slice(from, handle.indexOf('case "start_pro"', from));
  const start = handle.slice(handle.indexOf('case "start_pro"'));
  const branch = start.slice(0, start.indexOf('case "save_logo"'));

  it("is a checkout button under the upgrade card", () => {
    assert.match(offer, /sendProButton\(userId, ctx\.phone, proOffer\(used\), UPGRADE_CARD, log\)/);
  });

  it("falls back to the link in words, never to nothing", () => {
    assert.match(offer, /proPayLink\(proOffer\(used\), proStartUrl\(userId\)\)/);
    assert.match(branch, /proPayLink\(proPayPrompt\(\), proStartUrl\(userId\)\)/);
  });

  it("does not offer a second month to somebody already on Pro", () => {
    assert.match(branch, /planOf\(userId\)\) === "pro"/);
    assert.match(branch, /proActive\(/);
  });

  it("points at /pro/start, which opens a fresh checkout each time", () => {
    const helper = handle.slice(handle.indexOf("async function sendProButton"));
    assert.match(helper.slice(0, 1200), /url: proStartUrl\(userId\)/);
    const route = read("../http/routes/pro.ts");
    assert.match(route, /openProCheckout\(userId, req\.log\)/);
    assert.match(route, /reply\.redirect\(opened\.url, 303\)/);
  });

  it("says how it can be paid, and where the receipt goes", () => {
    const words = proPayPrompt();
    assert.match(words, /card, bank transfer or USSD/);
    assert.match(words, /receipt comes here and to your email/);
  });
});
