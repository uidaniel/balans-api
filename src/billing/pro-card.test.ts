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

import { proOffer, proOfferButtons, proTransferMessage } from "./messages.ts";
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
   * A reply button, and the account comes back in the chat.
   *
   * It was a link button to a page in WhatsApp's browser that showed the
   * account number. People asked for the number in the chat itself, so the
   * tap now arrives as "pay now" and the reply is the account.
   */
  const handle = read("../conversation/handle.ts");
  const from = handle.indexOf('case "show_upgrade"');
  const offer = handle.slice(from, handle.indexOf('case "start_pro"', from));

  it("is a reply button under the upgrade card, not a link out of the chat", () => {
    assert.match(offer, /buttonsImage = UPGRADE_CARD/);
    assert.match(offer, /buttons = proOfferButtons\(\)/);
    const code = offer.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /sendCta\(|proStartUrl/, "no link button on the offer");
    assert.equal(proOfferButtons()[0]!.title, "Pay Now");
  });
});

describe("paying for it", () => {
  const handle = read("../conversation/handle.ts");
  const start = handle.slice(handle.indexOf('case "start_pro"'));
  const branch = start.slice(0, 2000);

  it("puts the account in the chat", () => {
    assert.match(branch, /openProTransfer\(userId, log\)/);
    assert.match(branch, /extra\.push\(proTransferMessage\(transfer\.account, transfer\.amountKobo\)\)/);
    const code = branch.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /sendCta\(|checkoutUrl|initTransaction/, "no link, no Monnify");
  });

  it("says the bank, the number, the name and the exact amount", () => {
    const words = proTransferMessage(
      { bankName: "Wema Bank", accountNumber: "9912345678", accountName: "Balans", expiresAt: new Date("2026-09-26T15:00:00Z") },
      400000,
    );
    assert.match(words, /Wema Bank/);
    assert.match(words, /\*9912345678\*/);
    assert.match(words, /Account name: \*Balans\*/);
    assert.match(words, /exactly ₦4,000/);
    assert.match(words, /4:00\s?pm/i, "closing time in Lagos");
    assert.doesNotMatch(words, /https?:\/\//, "no link in it");
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
    assert.match(route, new RegExp(`"${PRO_CARD.split("/").pop()!.split("?")[0]}":`));
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
