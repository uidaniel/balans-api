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

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

  it("lands on the success page and stays there", () => {
    /*
     * It used to render its own page here, which navigated to `wa.me` after
     * four hundred milliseconds — WhatsApp intercepts its own links, so the
     * browser would go away and there would be nothing to close.
     *
     * The trick is real. The problem is that it fired whether or not it
     * worked, so somebody who had just paid ₦4,000 saw an acknowledgement
     * for four hundred milliseconds and then WhatsApp's own landing page.
     * No page can dismiss that browser reliably, so the page says what
     * happened, tries to close, and tells them they can close it.
     */
    // On what runs, not on what is written about it: the comment above the
    // branch names the thing it replaced, and has to be free to say so.
    const code = callback.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    assert.match(code, /\/pro\/success/, "the page built for this");
    assert.doesNotMatch(code, /renderProDone/, "not a second page saying the same thing");
    assert.doesNotMatch(code, /wa\.me/, "and nothing that navigates off it");
  });

  it("only says Pro is on once it actually is", () => {
    // The webhook is what activates a subscription and the browser can
    // arrive first, so this is a fact to check rather than assume. The page
    // reads it from the query string and says the other thing instead.
    assert.match(callback, /status === "active" \? "" : "\?state=confirming"/);
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
  const closer = read("../../../balans/src/app/pro/success/close-window.tsx");

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

  it("tries to close the window it is left in", () => {
    /*
     * The checkout opens over the chat, so finishing leaves a window sitting
     * on top of the conversation. `window.close()` only works on a window a
     * script opened, which this one usually is not — so it is an attempt, not
     * the plan.
     */
    assert.match(closer, /window\.close\(\)/);
    assert.match(closer, /catch/, "a browser refusing is expected, not an error");
  });

  it("tells them they can close it, once closing has failed", () => {
    /*
     * The order is the whole point. A page that says "closing…" and then does
     * not is worse than one that never said so, because the person waits for
     * it. So the line is written on the assumption the attempt failed, and
     * only appears once it has.
     */
    const rendered = closer.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    assert.match(rendered, /You can close this window/);
    assert.match(rendered, /setTimeout/, "said after the attempt, not before it");
    assert.match(rendered, /if \(!stuck\) return null/, "and nothing at all until then");
  });

  it("never navigates away from the acknowledgement", () => {
    /*
     * What this replaced: a redirect to `wa.me` four hundred milliseconds
     * after the page rendered. It fired whether or not WhatsApp caught the
     * link, so the page somebody paid ₦4,000 to reach was gone before it
     * could be read. Closing leaves the chat underneath; navigating does not.
     */
    assert.doesNotMatch(closer, /location\.(replace|assign|href)/);
    assert.doesNotMatch(closer, /wa\.me/);
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
