/**
 * Where somebody lands after paying for Pro.
 *
 * They landed on the marketing home page. `/pay/callback` resolves a payment
 * reference to a document so it can send the payer back to their invoice, and
 * a subscription has no document — the payer is us, there is nothing to
 * return to. The lookup found nothing, the fallback fired, and a person who
 * had just paid ₦4,000 got a product pitch, no acknowledgement, and no way
 * back to the chat they started in.
 *
 * Nothing failed. The join was correct, the fallback was correct, and the
 * case simply had no branch. That is why the test is written against the
 * route text: the bug was a missing branch, and the only thing that catches
 * a missing branch is an assertion that it is there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const route = read("../http/routes/public.ts");
// Bounded by the end of the handler rather than by a character count: the
// branch has grown twice and a fixed window stopped reaching the lines it was
// checking, so the tests failed while the code was right.
const callback = route.slice(
  route.indexOf('"/pay/callback"'),
  route.indexOf("/** The stored PDF"),
);

describe("coming back from a Pro payment", () => {
  it("recognises a subscription reference before looking for a document", () => {
    const sub = callback.indexOf('reference.startsWith("sub_")');
    const doc = callback.indexOf("tokenForReference(reference)");

    assert.ok(sub > -1, "a subscription has to have its own branch");
    assert.ok(sub < doc, "asked before a lookup that cannot succeed for one");
  });

  it("closes itself back to the chat rather than opening a web page", () => {
    /*
     * The checkout runs in WhatsApp's own browser, so finishing leaves
     * somebody looking at a page on top of the conversation they started in
     * — while the confirmation they want is a message in that conversation.
     * WhatsApp gives a page no way to dismiss its browser, but it does
     * intercept its own links, so the page navigates to wa.me.
     */
    assert.match(callback, /renderProDone\(/, "a page that takes them back");
    assert.doesNotMatch(callback, /\/pro\/success/, "not a marketing page to close by hand");
  });

  it("only says Pro is on once it actually is", () => {
    // The webhook is what activates a subscription and the browser can
    // arrive first, so this is a fact to check rather than assume.
    assert.match(callback, /active: status === "active"/);
  });

  it("still returns an invoice payer to their invoice", () => {
    // The change must not cost the case that already worked.
    assert.match(callback, /reply\.redirect\(`\/i\/\$\{token\}`, 303\)/);
  });

  it("uses the reference prefix the checkout actually writes", () => {
    // Two files agreeing on a string with nothing to enforce it.
    const pro = read("../http/routes/pro.ts");
    assert.match(pro, /const reference = `sub_\$\{/, "the checkout writes sub_");
  });
});

describe("the page it lands on", () => {
  const page = read("../../../balans/src/app/pro/success/page.tsx");
  const button = read("../../../balans/src/app/pro/success/back-to-chat.tsx");

  it("is kept out of search results", () => {
    // The end of a private flow. A stranger arriving on "payment received"
    // from a search result is a support message waiting to happen.
    assert.match(page, /robots:\s*\{\s*index:\s*false/);
  });

  it("offers the way back to the chat", () => {
    assert.match(page, /BackToChat/);
  });

  it("does not put the WhatsApp number on the site before it is public", () => {
    /*
     * The number is still in testing and must not ship in the site's bundle.
     * `chatHref` returns null while NEXT_PUBLIC_WA_NUMBER is unset, so the
     * button is a link only once that variable is set deliberately — and
     * never because somebody typed the digits into a page.
     */
    assert.doesNotMatch(button, /\d{10,}/, "no number literal anywhere in it");
    assert.doesNotMatch(page, /\d{10,}/);
    assert.match(button, /chatHref\(\)/, "the number comes from config or not at all");
    assert.match(button, /if \(!href\)/, "and there is a fallback for when it is not there");
  });

  it("does not tell a paying customer the number is revealing soon", () => {
    // The shared ChatLink says exactly that, which is written for a stranger
    // on the marketing site. This person was in the chat ninety seconds ago.
    // Asserted on what renders, not on the file: the comment above the
    // fallback explains why it is not reused and says the words.
    const rendered = button.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    assert.doesNotMatch(rendered, /revealing soon/);
    assert.match(rendered, /Head back to your Balans chat/, "an instruction, not a dead link");
  });
});
