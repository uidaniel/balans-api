/**
 * The draft says which account the client will pay into (20 October 2026).
 *
 * A naira invoice carries the sender's own account, and the client transfers
 * to it directly. The sender should see that account before pressing send,
 * so a wrong or old one is caught there rather than after a client has paid it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { draftSummary } from "./summary.ts";
import type { Draft } from "./store.ts";
import type { BankDetails } from "./bank-details.ts";

const N = (naira: number) => naira * 100;
const today = { y: 2026, m: 10, d: 20 };

const draft = (over: Partial<Draft>): Draft =>
  ({
    id: "d1",
    clientId: "c1",
    type: "invoice",
    clientName: "Zenith Homes",
    clientEmail: null,
    lines: [{ description: "duplex 3D render", qty: 1, unitAmountKobo: N(350_000) }],
    dueDate: { y: 2026, m: 10, d: 23 },
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    subtotalKobo: N(350_000),
    vatKobo: 0,
    totalKobo: N(350_000),
    number: 7,
    publicToken: "tok",
    ...over,
  }) as Draft;

const bank: BankDetails = {
  bankName: "GTBank",
  accountName: "Ada Obi",
  accountNumber: "0123456789",
  last4: "6789",
};

describe("draft: to be paid into", () => {
  it("shows the account name, bank and number on a naira invoice", () => {
    const text = draftSummary(draft({}), today, "pro", false, bank);
    assert.match(text, /To be paid into:\n\*Account name: Ada Obi\*\n\*Bank: GTBank\*\n\*Account number: 0123456789\*/);
    assert.ok(text.indexOf("To be paid into") < text.indexOf("Send it?"));
  });

  it("shows it on a payment request", () => {
    assert.match(draftSummary(draft({ type: "payment_request" }), today, "pro", false, bank), /To be paid into:/);
  });

  it("leaves it off a quote, which is not paid", () => {
    assert.doesNotMatch(draftSummary(draft({ type: "quote" }), today, "pro", false, bank), /paid into/);
  });

  it("leaves it off an invoice abroad, which is paid by card", () => {
    const foreign = { currency: "USD", amountMinor: 25_000, rate: 1400 } as Draft["foreign"];
    assert.doesNotMatch(draftSummary(draft({ foreign }), today, "pro", false, bank), /paid into/);
  });

  it("says nothing when there is no account in force", () => {
    assert.doesNotMatch(draftSummary(draft({}), today, "pro", false, null), /paid into/);
  });
});
