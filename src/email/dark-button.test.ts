/**
 * The button's label in dark mode (2 November 2026): Gmail recoloured the
 * dark text on the gold to light. Pinned for Apple Mail and Outlook, and
 * undone for Gmail with blended layers that only Gmail's markup matches.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { button, layout } from "./layout.ts";

describe("the button in dark mode", () => {
  const html = layout({ preheader: "p", heading: "h", body: button("Pay $860.00", "https://x.test/i/1") });

  it("keeps the label dark where dark mode is honoured", () => {
    assert.match(html, /@media \(prefers-color-scheme: dark\)[\s\S]*\.bl-btn, \.bl-btn span \{ color:#[0-9A-Fa-f]{6} !important; \}/);
    assert.match(html, /\[data-ogsc\] \.bl-btn/);
  });

  it("undoes Gmail's recolouring, only inside Gmail", () => {
    assert.match(html, /u \+ \.body \.bl-gmail-screen \{ background:#000; mix-blend-mode:screen; \}/);
    assert.match(html, /<body[^>]*class="body bl-canvas"/);
    assert.match(html, /<span class="bl-gmail-screen"><span class="bl-gmail-diff">Pay \$860\.00<\/span><\/span>/);
  });

  it("follows a brand's own label colour", () => {
    const branded = layout({ preheader: "p", heading: "h", body: button("Pay", "https://x.test"), brand: { name: "Ada", colour: "#10224A" } as never });
    assert.doesNotMatch(branded, /\.bl-btn span \{ color:#10231C !important; \}/i);
  });
});
