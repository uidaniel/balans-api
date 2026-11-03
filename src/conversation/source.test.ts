/**
 * Where a sign-up came from (3 November 2026): read from the first message.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sourceOf } from "./source.ts";
import { parseInbound } from "../whatsapp/inbound.ts";

describe("where a sign-up came from", () => {
  it("an ad, with its headline and id", () => {
    assert.deepEqual(sourceOf({ text: "Hi Balans, I want to try it", referral: { sourceType: "ad", sourceId: "120210", headline: "Get paid on WhatsApp" } }), {
      source: "ad",
      detail: "Get paid on WhatsApp",
      adId: "120210",
    });
  });

  it("a boosted post", () => {
    assert.equal(sourceOf({ text: "hi", referral: { sourceType: "post", sourceUrl: "https://fb.me/x" } }).source, "post");
  });

  it("the website, with the ?ref it was opened with", () => {
    assert.deepEqual(sourceOf({ text: "Hi Balans" }), { source: "website", detail: null, adId: null });
    assert.deepEqual(sourceOf({ text: "Hi Balans (ref: ig)" }), { source: "website", detail: "ig", adId: null });
  });

  it("the launch message's button, through balans.ng/start, is the waitlist", () => {
    assert.equal(sourceOf({ text: "Hi Balans (ref: launch)" }).source, "waitlist");
  });

  it("anything else is direct", () => {
    for (const text of ["hi", "Invoice Tunde 20k", "", "Hi Balans, how does it work?"]) {
      assert.equal(sourceOf({ text }).source, "direct", text);
    }
  });

  it("reads Meta's referral off the message", () => {
    const { messages } = parseInbound({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "1" },
        messages: [{ id: "wamid.1", from: "2348000000000", timestamp: "1762000000", type: "text", text: { body: "Hi" },
          referral: { source_type: "ad", source_id: "999", source_url: "https://fb.me/ad", headline: "Invoice in one line" } }],
      } }] }],
    });
    assert.equal(messages[0]!.referral?.sourceId, "999");
    assert.equal(sourceOf(messages[0]!).detail, "Invoice in one line");
  });
});
