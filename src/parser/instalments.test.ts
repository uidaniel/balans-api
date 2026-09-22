/**
 * Reading a payment plan out of a sentence.
 *
 * This exists because of a real message that this product got wrong:
 *
 *   "Invoice daniel 250k for website development, it is project running from
 *    1st of october to like the 3rd week and there will be milestones,
 *    3 payment shared equally"
 *
 * The draft that came back asked Daniel for ₦250,000 in one payment. The
 * milestones were not misread — they were not read at all, because nothing in
 * the parser could express them. Everything below is a sentence somebody would
 * plausibly type, and the last block is the sentences that must NOT be read as
 * a payment plan, which is the harder half.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractDocument, countOf } from "./extract.ts";
import { readCorrection } from "./corrections.ts";
import { MAX_INSTALMENTS } from "../documents/parts.ts";

const today = { y: 2026, m: 9, d: 22 };

const plan = (text: string) => extractDocument(text, today)?.options.instalments ?? null;
const deposit = (text: string) => extractDocument(text, today)?.options.depositPercent ?? null;

describe("reading instalments from a message", () => {
  it("reads the sentence that started this", () => {
    assert.equal(plan("invoice daniel 250k for website design, 3 payments shared equally"), 3);
  });

  it("reads the count in digits or in words", () => {
    assert.equal(plan("invoice tunde 300k for logo, 3 instalments"), 3);
    assert.equal(plan("invoice tunde 300k for logo, three instalments"), 3);
    assert.equal(plan("invoice tunde 300k for logo, in four installments"), 4);
    assert.equal(plan("invoice tunde 300k for logo, 2 milestones"), 2);
  });

  it("reads it when the verb leads", () => {
    assert.equal(plan("invoice tunde 300k for logo, split into 3"), 3);
    assert.equal(plan("invoice tunde 300k for logo, spread over 4 payments"), 4);
    assert.equal(plan("invoice tunde 300k for logo, paid in three parts"), 3);
  });

  it("takes the plan out of the description", () => {
    const got = extractDocument("invoice tunde 300k for logo design, 3 payments shared equally", today);
    assert.equal(got?.lineItems[0]?.description, "logo design");
  });

  it("keeps a deposit a deposit", () => {
    assert.equal(deposit("invoice tunde 300k for logo, 50% deposit"), 50);
    assert.equal(plan("invoice tunde 300k for logo, 50% deposit"), null);
  });
});

describe("what is not a payment plan", () => {
  // The expensive mistake. Reading a quantity as a payment plan turns one
  // invoice into three, and the client is asked for a third of the money.
  for (const text of [
    "invoice tunde 300k for 3 banners",
    "invoice tunde 300k for 2 logo concepts",
    "invoice tunde 300k for three months of hosting",
    "invoice tunde 300k for 4 hours of consulting",
  ]) {
    it(`leaves "${text.slice(18)}" alone`, () => {
      assert.equal(plan(text), null);
    });
  }

  it("refuses a count it cannot honour", () => {
    // A part must be worth something, and twenty payments is a subscription.
    assert.equal(plan("invoice tunde 300k for logo, 20 instalments"), null);
    assert.equal(plan("invoice tunde 300k for logo, 1 payment"), null);
  });

  it("countOf only accepts what shapeFor will take", () => {
    assert.equal(countOf("3"), 3);
    assert.equal(countOf("three"), 3);
    assert.equal(countOf(String(MAX_INSTALMENTS)), MAX_INSTALMENTS);
    assert.equal(countOf(String(MAX_INSTALMENTS + 1)), null);
    assert.equal(countOf("1"), null);
    assert.equal(countOf("banana"), null);
    assert.equal(countOf(undefined), null);
  });
});

describe("changing the plan on a draft", () => {
  it("reads a plan as a correction", () => {
    assert.equal(readCorrection("make it 3 payments", today)?.instalments, 3);
    assert.equal(readCorrection("split into four instalments", today)?.instalments, 4);
  });

  it("clears a deposit when a plan replaces it", () => {
    // Both set would be read by `shapeFor` as the deposit, so the correction
    // would appear to do nothing at all.
    const got = readCorrection("actually make it 3 payments", today);
    assert.equal(got?.instalments, 3);
    assert.equal(got?.depositPercent, null);
  });

  it("clears a plan when a deposit replaces it", () => {
    const got = readCorrection("make it 50% deposit", today);
    assert.equal(got?.depositPercent, 50);
    assert.equal(got?.instalments, null);
  });

  it("goes back to one payment", () => {
    assert.equal(readCorrection("no instalments", today)?.instalments, null);
    assert.equal(readCorrection("remove the milestones", today)?.instalments, null);
    assert.equal(readCorrection("one payment", today)?.instalments, null);
  });
});
