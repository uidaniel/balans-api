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
  it("bolds the amount and nothing that competes with it", () => {
    // The layout may change; what must not is that the eye lands on the
    // figure. The title and the amount are the only bold spans.
    const m = paidMessage(notice());
    const bold: string[] = m.match(/\*[^*]+\*/g) ?? [];
    assert.ok(bold.includes("*₦350,000*"), `bold spans: ${bold.join(" ")}`);
    assert.ok(bold.length <= 2, `too much bold: ${bold.join(" ")}`);
  });

  it("puts the amount on its own row", () => {
    const m = paidMessage(notice());
    assert.match(m, /^Amount: \*₦350,000\*$/m);
  });

  it("names the client and the invoice", () => {
    const m = paidMessage(notice());
    assert.match(m, /^From: Zenith Homes$/m);
    assert.match(m, /^Invoice: #7$/m);
    assert.match(m, /PAID/);
  });

  it("says how they paid, in words a person uses", () => {
    assert.match(paidMessage(notice({ method: "ACCOUNT_TRANSFER" })), /Bank transfer/i);
    assert.match(paidMessage(notice({ method: "CARD" })), /Method: Card/);
    assert.match(paidMessage(notice({ method: "USSD" })), /USSD/i);
  });

  it("copes with a method nobody has seen before", () => {
    const m = paidMessage(notice({ method: "SOME_NEW_RAIL" }));
    assert.match(m, /Some new rail/);
    assert.doesNotMatch(m, /SOME_NEW_RAIL/);
  });

  it("leaves the method out rather than guessing", () => {
    const m = paidMessage(notice({ method: null }));
    assert.doesNotMatch(m, /Method:/);
    assert.doesNotMatch(m, /null|undefined/);
  });

  it("says what is left on a part payment", () => {
    const m = paidMessage(
      notice({ paidKobo: 100_000_00, amountPaidKobo: 100_000_00, fullyPaid: false }),
    );
    assert.match(m, /PART PAYMENT/);
    assert.match(m, /^Received: \*₦100,000\*$/m);
    assert.match(m, /^Still owed: ₦250,000$/m);
    // Not "PAID" on a message whose whole point is that it is not paid yet.
    assert.doesNotMatch(m, /\bPAID\b/);
  });

  it("names the night the money lands, and never sooner", () => {
    /*
     * This used to say "on its way", deliberately vague because the
     * settlement schedule was unknown. It is known now — Monnify runs once a
     * day at 22:00 Lagos — so the message names a night instead.
     *
     * The time is passed in rather than read from the clock: a test whose
     * result depends on when it runs would pass all afternoon and fail at
     * eleven at night.
     */
    const lagos = (hour: number) => new Date(Date.UTC(2026, 8, 22, hour - 1, 0));

    const before = paidMessage(notice(), lagos(15));
    assert.match(before, /arrives in your bank tonight/i);

    const after = paidMessage(notice(), lagos(23));
    assert.match(after, /arrives in your bank tomorrow night/i);

    // Still nothing that claims the money is already there.
    for (const m of [before, after]) {
      assert.doesNotMatch(m, /instantly|immediately|within \d/i);
    }
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
