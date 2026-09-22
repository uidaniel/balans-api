/**
 * The card and the words under it say the same thing.
 *
 * Two cards, chosen by the clock: one reads "Paid before 10 PM? In your bank
 * tonight", the other "Paid after 10 PM? In your bank tomorrow night". The
 * caption says it in words too.
 *
 * Those are two separate statements about somebody's money, and the failure
 * that matters is them disagreeing — a picture promising tonight above a line
 * saying tomorrow. Both come from `settlesTonight`, and this is what holds
 * them to it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settlesTonight, SETTLEMENT_HOUR } from "./settlement.ts";
import { paidMessage, type PaidNotice } from "./notify.ts";

/** An instant, given as the hour in Lagos. Lagos is UTC+1 all year. */
const lagos = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 22, hour - 1, minute));

/** The same choice notifyPaid makes. */
const cardFor = (at: Date) => (settlesTonight(at) ? "paid-tonight.png" : "paid-tomorrow.png");

const notice: PaidNotice = {
  userId: "u",
  totalKobo: 150_000_00,
  amountPaidKobo: 150_000_00,
  clientName: "Sole Capsule",
  paidKobo: 150_000_00,
  documentNumber: 3,
  documentType: "invoice" as const,
  fullyPaid: true,
  method: "ACCOUNT_TRANSFER",
  paymentId: undefined,
};

describe("the payment card", () => {
  it("promises tonight before the run, and the caption agrees", () => {
    for (const h of [0, 9, 14, 21]) {
      const at = lagos(h);
      assert.equal(cardFor(at), "paid-tonight.png", `${h}:00 Lagos`);
      assert.match(paidMessage(notice, at), /in your bank tonight/i, `${h}:00 Lagos`);
    }
  });

  it("promises tomorrow night after it, and the caption agrees", () => {
    for (const h of [22, 23]) {
      const at = lagos(h);
      assert.equal(cardFor(at), "paid-tomorrow.png", `${h}:00 Lagos`);
      assert.match(paidMessage(notice, at), /tomorrow night/i, `${h}:00 Lagos`);
    }
  });

  it("switches both at the same minute", () => {
    // The boundary belongs to the later side: a payment at exactly 22:00 has
    // not beaten the run. The card and the words have to agree about that too.
    const just = lagos(SETTLEMENT_HOUR - 1, 59);
    const late = lagos(SETTLEMENT_HOUR, 0);

    assert.equal(cardFor(just), "paid-tonight.png");
    assert.match(paidMessage(notice, just), /tonight/i);

    assert.equal(cardFor(late), "paid-tomorrow.png");
    assert.match(paidMessage(notice, late), /tomorrow night/i);
  });

  it("never shows a card that contradicts its caption", () => {
    // Swept across the whole day rather than sampled, because the one thing
    // that must not happen is a picture promising tonight above a line saying
    // tomorrow.
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30, 59]) {
        const at = lagos(h, m);
        const saysTonight = /in your bank tonight/i.test(paidMessage(notice, at));
        const showsTonight = cardFor(at) === "paid-tonight.png";
        assert.equal(showsTonight, saysTonight, `card and caption disagree at ${h}:${m} Lagos`);
      }
    }
  });
});
