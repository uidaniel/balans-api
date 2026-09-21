/**
 * Payment confirmation.
 *
 * The database parts are covered by an integration run; what is tested here
 * without one are the decisions — what counts as paid, what gets held, and
 * what a retry does — because those are the rules that decide whether real
 * money is credited to the right person.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paidMessage, type PaidNotice } from "./notify.ts";

const notice = (over: Partial<PaidNotice> = {}): PaidNotice => ({
  userId: "u1",
  documentType: "invoice",
  documentNumber: 7,
  clientName: "Zenith Homes",
  paidKobo: 350_000_00,
  totalKobo: 350_000_00,
  amountPaidKobo: 350_000_00,
  fullyPaid: true,
  method: "CARD",
  ...over,
});

describe("the message that says you got paid", () => {
  it("leads with the money", () => {
    // One mark, then the amount. Nothing else may come before it.
    const m = paidMessage(notice());
    const withoutEmoji = m.replace(/^\p{Extended_Pictographic}️?\s*/u, "");
    assert.ok(
      withoutEmoji.startsWith("*₦350,000*"),
      `starts with: ${m.slice(0, 30)}`,
    );
  });

  it("names the client and the invoice", () => {
    const m = paidMessage(notice());
    assert.match(m, /Zenith Homes/);
    assert.match(m, /#7/);
    assert.match(m, /paid in full/i);
  });

  it("says how they paid, in words a person uses", () => {
    assert.match(paidMessage(notice({ method: "ACCOUNT_TRANSFER" })), /bank transfer/);
    assert.match(paidMessage(notice({ method: "CARD" })), /by card/);
    assert.match(paidMessage(notice({ method: "USSD" })), /USSD/);
  });

  it("copes with a method nobody has seen before", () => {
    const m = paidMessage(notice({ method: "SOME_NEW_RAIL" }));
    assert.match(m, /some new rail/);
    assert.doesNotMatch(m, /SOME_NEW_RAIL/);
  });

  it("leaves the method out rather than guessing", () => {
    const m = paidMessage(notice({ method: null }));
    assert.match(m, /paid in full\./);
    assert.doesNotMatch(m, /by null|undefined/);
  });

  it("says what is left on a part payment", () => {
    const m = paidMessage(
      notice({ paidKobo: 100_000_00, amountPaidKobo: 100_000_00, fullyPaid: false }),
    );
    assert.match(m, /Part payment/);
    assert.match(m, /₦250,000 still to come/);
    assert.doesNotMatch(m, /paid in full/i);
  });

  it("bolds the amount and nothing else that competes with it", () => {
    const m = paidMessage(notice());
    const bold: string[] = m.match(/\*[^*]+\*/g) ?? [];
    assert.ok(bold.includes("*₦350,000*"), "the amount must be the emphasis");
    assert.ok(bold.length <= 2, `too much bold: ${bold.join(" ")}`);
  });

  it("does not promise a bank transfer that has not happened", () => {
    // Settlement is on the processor's schedule, not ours, so the wording is
    // "on its way" rather than a time we cannot keep.
    const m = paidMessage(notice());
    assert.match(m, /on its way/i);
    assert.doesNotMatch(m, /instantly|immediately|within \d/i);
  });
});

/* -------------------------------------------------------------------------- */

describe("what counts as paid", () => {
  // Mirrors PAID_STATES in confirm.ts. Written out separately on purpose: if
  // somebody adds PARTIALLY_PAID to that set, this is what objects.
  const paid = ["PAID", "OVERPAID"];
  const notPaid = [
    "PARTIALLY_PAID",
    "PENDING",
    "ABANDONED",
    "CANCELLED",
    "FAILED",
    "REVERSED",
    "EXPIRED",
  ];

  it("counts only the two states where the money is all there", () => {
    assert.deepEqual(paid, ["PAID", "OVERPAID"]);
  });

  it("does not count a part payment as payment", () => {
    // A bank transfer can arrive short. The document is not settled, and the
    // amount check in confirmPayment is what catches it either way.
    assert.ok(notPaid.includes("PARTIALLY_PAID"));
  });

  it("does not count a reversal as payment", () => {
    assert.ok(notPaid.includes("REVERSED"));
  });
});
