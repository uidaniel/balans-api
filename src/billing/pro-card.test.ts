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

import { proOffer, proOfferButtons, payLinkCaption, payLinkMessage } from "./messages.ts";
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
      assert.match(route, new RegExp(`"${url.split("/").pop()}":`));
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

describe("the Pay Now button", () => {
  /*
   * It used to be a reply button.
   *
   * Tapping it sent the words "Pay Now" into the chat, the bot answered with
   * a second message, and the link was on that one — two taps and three
   * bubbles to reach a checkout, with the middle bubble saying nothing
   * anybody needed. A WhatsApp message carries reply buttons or one link
   * button and never both, so the offer's own button had to become the link.
   */
  const handle = read("../conversation/handle.ts");
  const from = handle.indexOf('case "show_upgrade"');
  const offer = handle.slice(from, handle.indexOf('case "start_pro"', from));

  it("is the link itself, not a reply that asks for one", () => {
    assert.match(offer, /sendCta\(/, "the offer goes out as a link button");
    assert.match(offer, /label: "Pay Now"/);
    assert.match(offer, /url: proStartUrl\(userId\)/);
  });

  it("points at our own page, not straight at the checkout", () => {
    /*
     * A WhatsApp message sits in the chat for ever and a Monnify checkout
     * URL does not. Somebody scrolling back to last week's offer has to find
     * a live link, and the transaction is made when they press it — so
     * reading the offer costs nothing at Monnify.
     */
    const link = readFileSync(new URL("./pro-link.ts", import.meta.url), "utf8");
    assert.match(link, /\/pro\/start\?t=/);

    // Asserted on the code, not the file: the comment above this branch
    // explains the choice and says the provider's name while doing it.
    const code = offer.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /monnify|checkoutUrl/i, "the button must not carry a checkout URL");
  });

  it("falls back without the picture before it falls back without the button", () => {
    // Meta documents image headers on cta_url and refuses them on a list, so
    // this is not taken on trust. Losing the picture beats losing the tap.
    const withCard = offer.indexOf("headerImage: UPGRADE_CARD");
    const withoutCard = offer.indexOf("const plain");
    const words = offer.indexOf("buttons = proOfferButtons()");

    assert.ok(withCard > -1 && withoutCard > withCard, "picture first, then without it");
    assert.ok(words > withoutCard, "and only then back to a reply button");
  });
});

describe("paying for it, by typing", () => {
  const handle = read("../conversation/handle.ts");
  const start = handle.slice(handle.indexOf('case "start_pro"'));
  const branch = start.slice(0, 3000);

  it("opens the checkout in WhatsApp, not in a browser tab", () => {
    /*
     * Tapping a bare URL hands the person to whatever browser their phone
     * opens, and they then pay on a page that arrived with no context. A
     * cta_url opens in WhatsApp's own browser, so the chat is still behind
     * it. It costs the same as the text message it replaces.
     */
    assert.match(branch, /sendCta\(/, "the link goes out as a button");
    const cta = branch.slice(branch.indexOf("sendCta("));
    assert.match(cta.slice(0, 400), /url: init\.checkoutUrl/);
  });

  it("keeps the price on the button", () => {
    const label = `Pay ${"\u20a64,000"}`;
    assert.ok(label.length <= 20, "a reply button title is capped at twenty");
    assert.match(branch, /label: `Pay \$\{formatNaira/);
  });

  it("does not put the URL in the words above it", () => {
    // Otherwise the message carries both, and the bare one is the one that
    // throws them out of the chat.
    assert.doesNotMatch(payLinkCaption(), /https?:\/\//);
    assert.match(payLinkCaption(), /4,000/, "but it still says the price");
  });

  it("falls back to the link when the button will not send", () => {
    // Words only, so the link has to be in them.
    assert.match(payLinkMessage("https://pay.example/x"), /https:\/\/pay\.example\/x/);
    assert.match(branch, /extra\.push\(payLinkMessage\(init\.checkoutUrl\)\)/);
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

describe("the card that arrives once the money is in", () => {
  const notify = read("../payments/notify.ts");

  it("rides on the activation message", () => {
    // The one message in the product somebody has actually paid for.
    const branch = notify.slice(notify.indexOf("text: proStarted("));
    assert.match(branch.slice(0, 700), /image: proCardUrl\(/);
  });

  it("is a third picture, not one of the other two", () => {
    // "Five done" and "Upgrade to Pro" are both offers. This one is a
    // receipt, and sending an offer to somebody who has just bought is the
    // shop assistant again.
    assert.notEqual(PRO_CARD, LIMIT_CARD);
    assert.notEqual(PRO_CARD, UPGRADE_CARD);
  });

  it("is served by the brand route", () => {
    const route = read("../http/routes/brand.ts");
    assert.match(route, new RegExp(`"${PRO_CARD.split("/").pop()}":`));
  });
});

describe("what the cards have painted on them", () => {
  /*
   * The cards are drawn from pro-cards.ts (npm run cards), so what they say is
   * read from the config when they are rendered. These check the page they
   * are rendered from; the PNGs in assets/brand have to be re-rendered after
   * a change, which is the one thing a test cannot do for you.
   */
  it("state the free document limit, in words", () => {
    const words = ["zero", "one", "two", "three", "four", "five", "six"];
    const html = proCardHtml("limit");
    const n = words[limit]!;
    assert.match(html, new RegExp(`${n[0]!.toUpperCase()}${n.slice(1)} done\\.`));
    assert.match(html, new RegExp(`covers ${n} documents a month`));
  });

  it("promise nothing that went away with the Monnify split", () => {
    for (const kind of ["limit", "upgrade"] as const) {
      // The words on the card, not the fonts embedded in its stylesheet.
      const words = proCardHtml(kind).replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
      assert.doesNotMatch(words, /\bfee\b/i, `${kind} still mentions a fee`);
    }
  });

  it("only say \"done\" on the card for somebody who is", () => {
    assert.doesNotMatch(proCardHtml("upgrade"), /done\./);
  });

  it("still match the Pro price", () => {
    assert.equal(defaults.plans.pro.priceKobo, 4_000_00, 'both cards say "₦4,000 a month"');
  });

  it("still match the number of designs", () => {
    assert.equal(availableTo("pro").length, 8, 'the cards say "8 invoice designs"');
  });

  it("no longer depends on the month painted into the card", () => {
    // pro.png reads "MEMBER SINCE SEP 2026", which would have been wrong for
    // everybody who subscribed later. The month is drawn over it now, so the
    // artwork's own date is no longer a claim anybody sees.
    const notify = read("../payments/notify.ts");
    assert.match(notify, /proCardUrl\(new Date\(\)\)/, "the card is asked for by month");
    assert.match(notify, /timeZone: defaults\.behaviour\.timezone/, "in Lagos, not UTC");
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
