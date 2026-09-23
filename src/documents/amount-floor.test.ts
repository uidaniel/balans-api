/**
 * Why an invoice has a smallest size, and why it is that size.
 *
 * Fees are charged per payment and the Balans fee has a floor of ₦100 on the
 * free plan, whatever the invoice is worth. So a small invoice is eaten by its
 * own costs and a very small one goes past that into nonsense — at ₦100 the
 * user's share comes out negative, which is not a bad deal but a broken
 * payment: the split handed to the processor asks it to send less than
 * nothing.
 *
 * ₦1,000 is where the relationship stops being silly, not a figure somebody
 * liked. These tests check the relationship, so that raising the minimum fee
 * without moving the floor fails here rather than on somebody's invoice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_INVOICE_KOBO, MIN_INVOICE_KOBO, invoiceableKobo } from "../../core/amount.ts";
import { payout } from "./summary.ts";
import { VOICE } from "../conversation/machine.ts";
import { readFileSync } from "node:fs";

const N = (naira: number) => naira * 100;
const draft = (totalKobo: number) => ({
  totalKobo,
  depositPercent: null,
  instalments: null,
  passFeesToClient: false,
});

describe("the floor under an invoice", () => {
  it("is above the point where the user receives nothing", () => {
    /*
     * The failure it exists to prevent. Below roughly ₦102 the fees exceed
     * the invoice, so `userReceivesKobo` is negative and the split sent to
     * Monnify is a subaccount share of less than zero.
     */
    assert.ok(payout(draft(MIN_INVOICE_KOBO), "free").receivesKobo > 0);

    // And it is not merely above it by a hair.
    const { receivesKobo, feesKobo } = payout(draft(MIN_INVOICE_KOBO), "free");
    assert.ok(
      receivesKobo > feesKobo * 5,
      `at the floor the user keeps ₦${receivesKobo / 100} against ₦${feesKobo / 100} of fees`,
    );
  });

  it("leaves the user most of the smallest invoice they can send", () => {
    // The number that makes the floor defensible: a fifth of it going to
    // fees would not be. This is the check that fails if the fee table moves.
    const { feesKobo } = payout(draft(MIN_INVOICE_KOBO), "free");
    const share = feesKobo / MIN_INVOICE_KOBO;

    assert.ok(share < 0.15, `fees are ${(share * 100).toFixed(1)}% of the smallest invoice`);
  });

  it("is a round number somebody can be told", () => {
    // It appears in a message. "₦1,000" is a sentence; "₦1,037" is a puzzle.
    assert.equal(MIN_INVOICE_KOBO % N(500), 0);
  });

  it("is under any real piece of work", () => {
    // A floor that refuses a genuine invoice is worse than no floor. Nobody
    // bills ₦600 for design, and everybody bills ₦5,000 for something.
    assert.ok(MIN_INVOICE_KOBO <= N(5_000));
  });
});

describe("the ceiling over one", () => {
  it("is far above any invoice this is for", () => {
    // A guard against a keyboard, not a policy. It must never be the reason
    // a real job is refused.
    assert.ok(MAX_INVOICE_KOBO >= N(10_000_000));
  });

  it("still refuses the figure a slipped keyboard produces", () => {
    assert.equal(invoiceableKobo(N(999_999_999_999)), "large");
  });
});

describe("what gets refused", () => {
  it("takes the invoice that sits exactly on each end", () => {
    // Inclusive at both ends, so the number in the message is a figure that
    // actually works rather than one a kobo away from working.
    assert.equal(invoiceableKobo(MIN_INVOICE_KOBO), null);
    assert.equal(invoiceableKobo(MAX_INVOICE_KOBO), null);
  });

  it("refuses the kobo either side of them", () => {
    assert.equal(invoiceableKobo(MIN_INVOICE_KOBO - 1), "small");
    assert.equal(invoiceableKobo(MAX_INVOICE_KOBO + 1), "large");
  });

  it("judges the total, never a line", () => {
    /*
     * A ₦500 delivery charge inside a ₦50,000 invoice is a real line item.
     * The rule is about what the whole thing is worth, which is also the
     * only figure the fees are charged against.
     */
    assert.equal(invoiceableKobo(N(50_000)), null);
  });
});

describe("how it is said", () => {
  it("gives the figure back, not just the rule", () => {
    // Somebody who meant ₦500,000 and typed a zero too many has to be able
    // to see which of those two they actually sent.
    assert.match(VOICE.amountTooSmall(N(400)), /₦400\b/);
    assert.match(VOICE.amountTooLarge(N(500_000_000)), /₦500,000,000/);
  });

  it("says why, so it reads as a reason rather than a rule", () => {
    // "Minimum ₦1,000" is a policy nobody agreed to. The fees are the
    // actual cause and the only thing a user can act on.
    assert.match(VOICE.amountTooSmall(N(400)), /fees/i);
    assert.match(VOICE.amountTooSmall(N(400)), /₦1,000/);
  });

  it("offers the way out it actually has", () => {
    // Neither message may suggest something that would be refused again.
    assert.match(VOICE.amountTooSmall(N(400)), /Bill for more|one invoice/);
    assert.match(VOICE.amountTooLarge(N(500_000_000)), /more than one invoice/);
  });
});

describe("where it is checked", () => {
  /*
   * Read from the source, because a form, a typed sentence and a correction
   * are three routes to the same place and the bug would be a missing branch
   * on one of them. `save_draft` is where all three arrive, and it is the
   * last point at which refusing costs the user nothing — after it they have
   * read and approved something we then decline to send.
   */
  const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");
  const branch = handle.slice(
    handle.indexOf('case "save_draft"'),
    handle.indexOf('case "send_document"'),
  );

  it("sits on the one path every draft takes", () => {
    assert.ok(branch.length > 0, "save_draft has moved");
    assert.match(branch, /invoiceableKobo\(/, "nothing checks what the invoice is worth");
  });

  it("refuses before the draft is written, not after", () => {
    const checked = branch.indexOf("invoiceableKobo(");
    const written = branch.indexOf("createDraft(");

    assert.ok(checked > -1 && written > -1);
    assert.ok(checked < written, "the draft is saved before anybody asks what it is worth");
  });

  it("holds the conversation rather than leaving it mid-draft", () => {
    // Without this the user is left in awaiting_confirm with no draft, and
    // the next "yes" refers to nothing.
    const after = branch.slice(branch.indexOf("invoiceableKobo("));
    assert.match(after.slice(0, 400), /holdAt = "idle"/);
  });
});
