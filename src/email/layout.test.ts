/**
 * The email shell, and the things about it that cannot be checked by eye.
 *
 * Dark mode most of all. Gmail rewrites colours after delivery by rules it
 * does not publish, and Apple Mail swaps to the palette in the <style> block.
 * Neither shows up in a local render, so what the shell promises about them
 * is written down here.
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
  it("is a card on a desktop and edge to edge on a phone", () => {
    const card = html.match(/<table[^>]*class="bl-card[^"]*"/)![0];
    assert.match(card, /background:#FCFCFB/);
    assert.match(card, /border:1px solid #DFE0DA/);
    // Under 480px the frame goes and the hairline along the top stays.
    assert.match(html, /\.bl-card \{ border-radius:0 !important; border-left:0 !important; border-right:0 !important; \}/);
    assert.match(html, /\.bl-shell \{ padding:0 !important; \}/);
  });

  it("writes the name as text, so a client that darkens it can recolour it", () => {
    // Gmail's dark mode recolours text and never images. The name was a
    // picture, and arrived as ink on its dark page.
    assert.match(html, /class="bl-ink">balans<\/td>/);
    assert.match(html, /src="cid:balans-mark"/);
  });

  it("keeps every picture as an attachment, not a hosted image", () => {
    // Gmail and Outlook block remote images on first open. A logo that only
    // appears for people who click "display images" is not a logo.
    assert.doesNotMatch(html, /<img[^>]+src="https?:/);
    const withBanner = layout({
      preheader: "p",
      heading: "h",
      body: "",
      banner: { cid: "welcome-banner", file: "welcome-banner.png", alt: "A banner", width: 536, height: 214 },
    });
    assert.match(withBanner, /src="cid:welcome-banner"/);
  });

  it("fetches no fonts", () => {
    // A web font is a request on open, which Gmail refuses and which tells
    // whoever serves it that the message was read.
    assert.doesNotMatch(html, /@font-face/);
  });

  it("puts the two required lines in the footer", () => {
    assert.match(html, /Balans is a product of /);
    assert.match(html, /Payments are processed by Monnify/);
  });

  it("declares both themes, and overrides the inline light one for dark", () => {
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.match(html, /\.bl-card \{ background:#101210 !important;/);
  });
});
