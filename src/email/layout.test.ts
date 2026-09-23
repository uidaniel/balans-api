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
  it("is a column on the page, not a card on a background", () => {
    // No frame and no second colour: the body and the column are the same
    // paper, and nothing draws a border round it.
    const body = html.match(/<body[^>]*style="([^"]*)"/)![1]!;
    assert.match(body, /background:#FFFFFF/);
    assert.doesNotMatch(html, /border:1px solid/);
    assert.doesNotMatch(html, /#F6F1E7;/, "no cream canvas behind the column");
  });

  it("carries a logo for each theme, both as attachments", () => {
    // Gmail and Outlook block remote images on first open. A logo that only
    // appears for people who click "display images" is not a logo.
    assert.match(html, /src="cid:balans-logo"/);
    assert.match(html, /src="cid:balans-logo-dark"/);
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
    assert.match(html, /\.bl-paper \{ background:#10231C !important; \}/);
  });
});
