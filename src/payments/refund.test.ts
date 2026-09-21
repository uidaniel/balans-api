/**
 * Reversals.
 *
 * What a refund or a chargeback says to the user, and the rule that decides
 * whether the invoice goes back to unpaid or stays part-paid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reversedMessage } from "./refund.ts";

const notice = (over: Record<string, unknown> = {}) =>
  ({
    userId: "u1",
    documentType: "invoice",
    documentNumber: 7,
    clientName: "Zenith Homes",
    reversedKobo: 50_000_00,
    to: "refunded" as const,
    stillPaidKobo: 0,
    ...over,
  }) as Parameters<typeof reversedMessage>[0];

describe("a refund", () => {
  it("names the amount, the client and the invoice", () => {
    const m = reversedMessage(notice());
    assert.match(m, /₦50,000/);
    assert.match(m, /Zenith Homes/);
    assert.match(m, /#7/);
    assert.match(m, /refunded/i);
  });

  it("says the invoice is owed again when nothing is left paid", () => {
    assert.match(reversedMessage(notice()), /unpaid again/i);
  });

  it("says what survives a partial refund", () => {
    const m = reversedMessage(notice({ reversedKobo: 20_000_00, stillPaidKobo: 30_000_00 }));
    assert.match(m, /₦30,000 of that invoice is still paid/);
    assert.doesNotMatch(m, /unpaid again/i);
  });
});

describe("a chargeback", () => {
  it("says what is happening and what it means for them", () => {
    const m = reversedMessage(notice({ to: "disputed" }));
    assert.match(m, /disputed/i);
    assert.match(m, /on hold/i);
  });

  it("promises that money already taken is still safe", () => {
    // A user whose account is frozen needs to know the invoices already out
    // there still work, or they will assume the worst.
    const m = reversedMessage(notice({ to: "disputed" }));
    assert.match(m, /payments on invoices you already sent still work/i);
  });

  it("does not blame the user for it", () => {
    const m = reversedMessage(notice({ to: "disputed" }));
    assert.doesNotMatch(m, /fraud|suspicious|violation|breach/i);
  });

  it("offers a person", () => {
    assert.match(reversedMessage(notice({ to: "disputed" })), /reply here|emailed you/i);
  });
});
