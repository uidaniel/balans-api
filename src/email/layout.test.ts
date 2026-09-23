/**
 * The email shell, and the one thing about it that cannot be checked by eye.
 *
 * Everything else in here is visible the moment you open a test send. Dark
 * mode is not: Gmail rewrites colours after delivery, by rules it does not
 * publish, and no amount of local rendering will show you the result. So the
 * wordmark went out as ink on a background Gmail had darkened, and read as
 * nothing but the green cast in #10231C.
 *
 * Declaring a background beside the colour is the standard mitigation — it
 * gives the client a pair to reason about rather than a colour on its own.
 * It is not a guarantee, which is why the rule is written down here: the next
 * person to tidy these styles will not know it was deliberate, and will not
 * find out from looking at the email.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layout } from "./layout.ts";

const html = layout({
  preheader: "A preview line.",
  heading: "Your spot is saved",
  body: "<p>Body copy.</p>",
});

describe("the email shell", () => {
  it("draws the logo as a picture, with a background declared beside every colour", () => {
    // No mail client has the face the wordmark is drawn in, so it is an
    // image; and an image cannot be recoloured, so the text around it has to
    // carry its own background for Gmail to reason about.
    assert.match(html, /<img src="cid:balans-logo"[^>]+alt="Balans"/);
    const h1 = html.match(/<h1[^>]*style="([^"]*)"/)![1]!.replace(/\s+/g, " ");
    assert.match(h1, /(?<!-)color:#10231C/, "in ink");
    assert.match(h1, /background-color:#FFFFFF/, "on the card, declared");
  });

  it("keeps every picture as an attachment, not a hosted image", () => {
    // Gmail and Outlook block remote images on first open. A logo that only
    // appears for people who click "display images" is not a logo.
    const withBanner = layout({
      preheader: "p",
      heading: "h",
      body: "",
      banner: { cid: "welcome-banner", file: "welcome-banner.png", alt: "A banner", width: 486, height: 194 },
    });
    assert.match(withBanner, /src="cid:welcome-banner"/);
    assert.doesNotMatch(withBanner, /<img[^>]+src="https?:/);
  });

  it("puts the two required lines in the footer", () => {
    assert.match(html, /Balans is a product of /);
    assert.match(html, /Payments are processed by Monnify/);
  });

  it("asks the client not to invert it in the first place", () => {
    // Apple Mail honours this. Gmail does not, which is why the colours
    // carry backgrounds and the logo carries an outline.
    assert.match(html, /name="color-scheme" content="light"/);
  });
});
