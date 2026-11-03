/**
 * The button's label in dark mode. Pinned dark for Apple Mail and Outlook
 * (2 November 2026). Gmail gets no trick since 4 November 2026: blended
 * layers drew the label as two white bars in the Gmail iPhone app.
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

  it("is the label as text, centred by padding, with nothing over it", () => {
    assert.doesNotMatch(html, /mix-blend-mode|bl-gmail|<img [^>]*label/);
    assert.match(html, /class="bl-btn"[^>]*padding:12px 28px[^>]*>Pay \$860\.00<\/a>/);
  });

  it("follows a brand's own label colour", () => {
    const branded = layout({ preheader: "p", heading: "h", body: button("Pay", "https://x.test"), brand: { name: "Ada", colour: "#10224A" } as never });
    assert.doesNotMatch(branded, /\.bl-btn span \{ color:#10231C !important; \}/i);
  });
});
