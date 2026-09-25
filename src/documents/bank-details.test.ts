/**
 * Naira invoices paid straight to the sender's account (Bank Details
 * Invoices addendum, as decided 25 Sep 2026): the link stays on everything,
 * and on a naira invoice it opens the account instead of a checkout.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliveryFor, untrackedNote } from "./bank-details.ts";
import { renderDocument } from "./page.ts";
import { payable, type PublicDocument } from "./public.ts";
import { payBy, bankDetailsSentNote } from "./summary.ts";
import { asCommand } from "../parser/commands.ts";

const bank = { bankName: "GTBank", accountName: "KEMI ADEYEMI STUDIO", accountNumber: "0123456789", last4: "6789" };

const doc = (over: Partial<PublicDocument> = {}): PublicDocument => ({
  id: "1", userId: "2", type: "invoice", number: 7, status: "sent",
  businessName: "Kemi Adeyemi Studio", clientName: "Zenith Homes",
  lines: [{ description: "render", qty: 1, unitAmountKobo: 350_000_00, amountKobo: 350_000_00, originalAmountMinor: null }],
  subtotalKobo: 350_000_00, vatKobo: 0, totalKobo: 350_000_00, amountPaidKobo: 0, passFeesToClient: false,
  dueDate: { y: 2026, m: 10, d: 2 }, issueDate: { y: 2026, m: 9, d: 25 }, notes: null,
  subAccountCode: "MFY", plan: "pro", parts: [], foreign: null, bank,
  ...over,
});

describe("which way a document is paid", () => {
  it("is the sender's account in naira, and a card link abroad", () => {
    assert.equal(deliveryFor("invoice", "NGN"), "bank_details");
    assert.equal(deliveryFor("payment_request", "NGN"), "bank_details");
    assert.equal(deliveryFor("invoice", "USD"), "payment_link");
    // A quote is not paid; the invoice it becomes is decided on its own.
    assert.equal(deliveryFor("quote", "NGN"), "payment_link");
  });
});

describe("the page a naira invoice's link opens", () => {
  const html = renderDocument(doc(), { y: 2026, m: 9, d: 25 }, { token: "a".repeat(32) });

  it("shows the account to pay into, and no Pay button", () => {
    assert.equal(payable(doc()).ok, false);
    assert.match(html, /Pay by bank transfer/);
    assert.match(html, /0123456789/);
    assert.match(html, /KEMI ADEYEMI STUDIO/);
    assert.doesNotMatch(html, /class="pay-btn"/);
  });

  it("says a direct payment is not tracked, and names no processor", () => {
    assert.match(html, /not tracked automatically/);
    assert.doesNotMatch(html, /Monnify/);
  });

  it("still says paid once it is", () => {
    const paid = renderDocument(doc({ amountPaidKobo: 350_000_00, status: "paid" }), { y: 2026, m: 9, d: 25 }, { token: "a".repeat(32) });
    assert.match(paid, /Paid in full/);
    assert.doesNotMatch(paid, /Pay by bank transfer/);
  });
});

describe("the messages", () => {
  it("keeps the link, and says what it opens", () => {
    assert.match(payBy("https://payment.balans.ng/i/abc", bank), /account to pay into:\nhttps:\/\/payment\.balans\.ng\/i\/abc/);
    assert.match(payBy("https://payment.balans.ng/i/abc", null), /Click the link to pay:/);
  });

  it("tells the sender how it becomes paid, in the words that do it", () => {
    assert.match(bankDetailsSentNote(16, "Zenith"), /\*Zenith paid invoice 16\*/);
    assert.match(untrackedNote("Kemi"), /Ask Kemi for confirmation/);
  });
});

describe("telling us about a payment", () => {
  it("reads the ways people say it", () => {
    for (const t of ["Zenith paid invoice 16", "zenith homes has paid invoice #16", "paid invoice 16", "mark invoice 16 as paid", "invoice 16 is paid"]) {
      assert.deepEqual(asCommand(t), { intent: "record_payment", documentNumber: 16 }, t);
    }
  });

  it("reads the two buttons under the question", () => {
    assert.deepEqual(asCommand("yes mark invoice 16 paid"), { intent: "confirm_payment", documentNumber: 16 });
    assert.deepEqual(asCommand("leave invoice 16 unpaid"), { intent: "decline_payment", documentNumber: 16 });
  });

  it("opens the signature page from the slash command too", () => {
    assert.deepEqual(asCommand("/signature"), { intent: "signature" });
    assert.deepEqual(asCommand("signature"), { intent: "signature" });
    assert.deepEqual(asCommand("remove signature"), { intent: "remove_signature" });
  });
});
