/**
 * The email button's label as a picture (4 November 2026), so Gmail's dark
 * mode cannot turn it white; its words stay as the alt text.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { button, layout } from "../email/layout.ts";
import { addressFor } from "../email/send.ts";
import { buttonLabelUrl, labelWidth, validColour, validLabel } from "./button-label.ts";

describe("the button's label picture", () => {
  it("is in the button, with the words as alt text", () => {
    const html = button("Pay ₦500,000", "https://x.test/i/1");
    assert.match(html, /<img src="[^"]+\/brand\/label\.png\?t=Pay%20%E2%82%A6500%2C000&amp;c=10231C" width="\d+" height="22" alt="Pay ₦500,000"/);
    assert.doesNotMatch(html, /mix-blend-mode/);
  });

  it("follows a brand's own label colour", () => {
    const html = layout({ preheader: "p", heading: "h", body: button("Pay", "https://x.test"), brand: { name: "Ada", colour: "#10224A" } as never });
    assert.doesNotMatch(html, /c=10231C/);
    assert.match(html, /label\.png\?t=Pay&amp;c=[0-9A-F]{6}/);
  });

  it("takes only words an amount needs, and a plain colour", () => {
    assert.ok(validLabel("Pay ₦500,000"));
    assert.ok(validLabel("See how to pay"));
    assert.ok(!validLabel("<script>"));
    assert.ok(!validLabel("x".repeat(41)));
    assert.ok(validColour("10231C"));
    assert.ok(!validColour("red"));
    assert.ok(labelWidth("Pay ₦500,000") > 100);
    assert.match(buttonLabelUrl("View quote", "#10231c"), /\?t=View%20quote&c=10231C$/);
  });
});

describe("which address an email comes from (4 November 2026)", () => {
  it("is the kind of mail it is, on our domain", () => {
    const before = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = "Balans <onboarding@balans.ng>";
    try {
      assert.equal(addressFor("invoicing"), "invoicing@balans.ng");
      assert.equal(addressFor("disputes"), "disputes@balans.ng");
      assert.equal(addressFor(), "onboarding@balans.ng");
    } finally {
      if (before === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = before;
    }
  });
});
