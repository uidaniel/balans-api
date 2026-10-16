/**
 * A Pro brand colour replacing marigold, and staying readable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBrand, contrast, deepen, night, normaliseHex, onColour } from "./colour.ts";

describe("brand colour", () => {
  it("takes the ways people write a colour, and refuses the rest", () => {
    assert.equal(normaliseHex("#1a73e8"), "#1A73E8");
    assert.equal(normaliseHex("1A73E8"), "#1A73E8");
    assert.equal(normaliseHex("#1a7"), "#11AA77");
    assert.equal(normaliseHex("blue"), null);
    assert.equal(normaliseHex("#12345"), null);
    assert.equal(normaliseHex(null), null);
  });

  it("puts white on a dark colour and ink on a light one", () => {
    assert.equal(onColour("#0B1F4B"), "#FFFFFF");
    assert.equal(onColour("#F5B82E"), "#10231C");
  });

  it("darkens a pale colour until it reads as text on white", () => {
    const d = deepen("#FFE600");
    assert.ok(contrast(d, "#FFFFFF") >= 3, d);
    assert.equal(deepen("#0B1F4B"), "#0B1F4B", "a dark colour is left alone");
  });

  it("deepens any colour until light text reads on it, keeping its hue", () => {
    for (const c of ["#5B4BA5", "#F5B82E", "#FFE600", "#F0F0F0", "#22C55E"]) {
      assert.ok(contrast(night(c), "#FFFFFF") >= 9, `${c} → ${night(c)}`);
    }
    const [r, , b] = [1, 3, 5].map((i) => parseInt(night("#5B4BA5").slice(i, i + 2), 16)) as [number, number, number];
    assert.ok(b > r, "a purple stays a purple");
  });

  it("swaps marigold for the brand, in any case, and nothing else", () => {
    const out = applyBrand(
      `<html><head><style>a{color:#F5B82E}b{color:#f5b82e}i{color:#D99A12}u{color:#10231C}</style></head></html>`,
      "#0B1F4B",
    );
    assert.doesNotMatch(out, /f5b82e|d99a12/i);
    assert.match(out, /a\{color:#0B1F4B\}b\{color:#0B1F4B\}/);
    assert.match(out, /u\{color:#10231C\}/, "ink untouched");
    assert.match(out, /button\.pay-btn[^}]*color:#FFFFFF/, "text on the colour turns white");
  });

  it("never touches six hex digits without a #, which can sit inside embedded font data", () => {
    const font = "url(data:font/woff2;base64,AAf5b82eZZ)";
    assert.match(applyBrand(`<html><head><style>${font}</style></head></html>`, "#0B1F4B"), /AAf5b82eZZ/);
  });

  it("changes nothing without a colour", () => {
    assert.equal(applyBrand("<p style='color:#F5B82E'>x</p>", null), "<p style='color:#F5B82E'>x</p>");
  });
});
