/**
 * The page that closes itself after a Pro payment.
 *
 * The checkout runs in WhatsApp's own browser, so finishing leaves somebody
 * looking at a page on top of the conversation they started in — while the
 * confirmation they actually want is a message in that conversation.
 *
 * WhatsApp gives a page no way to dismiss that browser. What it does do is
 * intercept its own links: navigating to `wa.me` hands control back to the
 * app and the browser goes away. That is the close.
 *
 * Both of the tricks it tries can fail, on a phone, at the moment somebody
 * has just parted with ₦4,000. So most of what is checked here is that the
 * page is worth looking at when neither of them fires.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderProDone } from "./pro-done.ts";

const NUMBER = "2349052995617";

describe("the page after paying", () => {
  const done = renderProDone({ waNumber: NUMBER, active: true });

  it("goes back to the chat rather than sitting there", () => {
    assert.match(done, new RegExp(`https://wa\\.me/${NUMBER}`), "the way back");
    assert.match(done, /location\.replace\(/, "and it takes itself there");
  });

  it("tries the quiet way first", () => {
    // window.close() works in some browsers and not WhatsApp's. It costs
    // nothing to try, and the redirect is behind it either way.
    assert.ok(done.indexOf("window.close()") < done.indexOf("location.replace("));
  });

  it("says what happened before it tries anything", () => {
    // Both tricks can fail, and a blank screen is the wrong failure on a
    // phone that has just taken somebody's money.
    assert.match(done, /You're on Pro/);
    assert.ok(done.indexOf("You're on Pro") < done.indexOf("<script"), "words first");
  });

  it("leaves a link to press when nothing fires", () => {
    assert.match(done, /Back to WhatsApp/);
  });

  it("is not indexable", () => {
    assert.match(done, /noindex/);
  });
});

describe("when the webhook has not landed yet", () => {
  const waiting = renderProDone({ waNumber: NUMBER, active: false });

  it("does not claim Pro is on", () => {
    // The browser can easily beat the webhook here.
    assert.doesNotMatch(waiting, /You're on Pro/);
    assert.match(waiting, /Payment received/);
  });

  it("says what happens next", () => {
    assert.match(waiting, /message you the moment/);
  });

  it("still takes them back to the chat", () => {
    assert.match(waiting, new RegExp(`https://wa\\.me/${NUMBER}`));
  });
});

describe("when Meta will not say what our number is", () => {
  const stranded = renderProDone({ waNumber: null, active: true });

  it("still says what happened", () => {
    assert.match(stranded, /You're on Pro/);
  });

  it("offers no link rather than a broken one", () => {
    // wa.me with no number opens a page that does nothing, which is worse
    // than the page they are already looking at.
    assert.doesNotMatch(stranded, /wa\.me/);
    assert.doesNotMatch(stranded, /location\.replace\(/, "and nothing to redirect to");
    assert.doesNotMatch(stranded, /Back to WhatsApp/);
  });
});
