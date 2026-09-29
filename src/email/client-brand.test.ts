/**
 * A Pro business's email to its client carries the business, not us.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { button, layout, paragraph } from "./layout.ts";
import { sentAs } from "./client-brand.ts";

const body = [paragraph("Tolu,"), button("Pay ₦350,000", "https://payment.example/i/x")].join("\n");

describe("an email sent as the business (Pro)", () => {
  const logo = { cid: "brand-logo", file: "logo.png", bytes: Buffer.from("x"), contentType: "image/png", alt: "", width: 0, height: 0 };
  const html = layout({
    preheader: "₦350,000",
    heading: "Invoice #14",
    body,
    brand: { name: "Adebayo Designs", logo, colour: "#0B1F4B" },
  });

  it("has their logo where ours goes, and none of ours", () => {
    assert.match(html, /src="cid:brand-logo"/);
    assert.doesNotMatch(html, /cid:balans-mark/);
    assert.doesNotMatch(html, />balans</);
  });

  it("names them in the footer, and not us", () => {
    assert.match(html, /Sent by Adebayo Designs\./);
    assert.doesNotMatch(html, /Balans is a product|&copy; \d{4} Balans|Terms<\/a>/);
  });

  it("puts their colour on the button, with a label that reads on it", () => {
    assert.match(html, /background:#0B1F4B;border-radius:999px;color:#FFFFFF;/);
    assert.doesNotMatch(html, /#F5B82E/i);
  });

  it("comes from the business alone, without our coin attached", () => {
    assert.deepEqual(sentAs("Adebayo Designs", { name: "Adebayo Designs", logo, colour: null }), {
      fromName: "Adebayo Designs",
      noMark: true,
      images: [logo],
    });
  });

  it("uses their name in type when there is no logo", () => {
    const plain = layout({ preheader: "x", heading: "x", body, brand: { name: "Adebayo Designs", logo: null, colour: null } });
    assert.match(plain, />Adebayo Designs<\/p>/);
    assert.doesNotMatch(plain, /cid:/);
  });
});

describe("an email on Free", () => {
  it("is still Balans's, via Balans", () => {
    const html = layout({ preheader: "x", heading: "x", body });
    assert.match(html, /cid:balans-mark/);
    assert.match(html, /Balans is a product of/);
    assert.equal(sentAs("Adebayo Designs", null).fromName, "Adebayo Designs via Balans");
  });
});
