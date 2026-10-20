import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paidOut, payoutMessage } from "./payouts.ts";

describe("the payout message", () => {
  it("says how much, for which invoice, and where it went", () => {
    const m = payoutMessage({ amountKobo: 127_909, invoices: ["0002"], account: "Access Bank ••5673" });
    assert.match(m, /₦1,279\.09/);
    assert.match(m, /invoice 0002/);
    assert.match(m, /Access Bank ••5673/);
  });

  it("names every invoice in one payout", () => {
    assert.match(payoutMessage({ amountKobo: 1_000_00, invoices: ["0002", "0003"], account: null }), /invoices 0002, 0003 has been paid into your bank account/);
  });
});

describe("finding whose payout it is", () => {
  it("goes by the subaccount, not the transactions Paystack lists under it", async () => {
    // The subaccount's settlement lists no transactions; the payment sits under
    // the account's own ₦0 settlement. Matching by transaction told nobody.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./payouts.ts", import.meta.url), "utf8");
    assert.match(src, /paystack_subaccount_code = \$1/);
    assert.doesNotMatch(src, /\/settlement\/\$\{id\}\/transactions/);
  });

  it("says something true with no invoice to name", () => {
    assert.match(payoutMessage({ amountKobo: 5_000_00, invoices: [], account: "GTBank ••0001" }), /for your card payments/);
  });
});

describe("what reached the bank (20 October 2026)", () => {
  /*
   * The real one: invoice 0013 settled as ₦255,754.71, and Access Bank was
   * credited ₦254,423.71. Paystack had kept back ₦1,331, the refund on
   * invoice 0002. The message said the bigger number.
   */
  it("says the figure after Paystack's deductions, whichever field carries it", () => {
    assert.deepEqual(paidOut({ total_amount: 25_575_471, deductions: 133_100 }), { paidKobo: 25_442_371, deductedKobo: 133_100 });
    assert.deepEqual(paidOut({ total_amount: 25_575_471, effective_amount: 25_442_371 }), { paidKobo: 25_442_371, deductedKobo: 133_100 });
    assert.deepEqual(paidOut({ total_amount: 25_575_471, effective_amount: "25442371" as never, deductions: "133100" as never }).paidKobo, 25_442_371);
  });

  it("is the total when nothing was kept back", () => {
    assert.deepEqual(paidOut({ total_amount: 127_909 }), { paidKobo: 127_909, deductedKobo: 0 });
    assert.deepEqual(paidOut({ total_amount: 127_909, deductions: 0, effective_amount: 127_909 }), { paidKobo: 127_909, deductedKobo: 0 });
  });

  it("names what was kept back, and for which refund", () => {
    const m = payoutMessage({ amountKobo: 25_442_371, invoices: ["0013"], account: "Access Bank ••5673", deductedKobo: 133_100, refundedOn: ["0002"] });
    assert.match(m, /₦254,423\.71\* for invoice 0013/);
    assert.match(m, /Paystack kept back ₦1,331 for a refund on invoice 0002, so this is ₦255,754\.71 less ₦1,331\./);
  });

  it("tells the bank's figure on the template too, and records it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./payouts.ts", import.meta.url), "utf8");
    assert.match(src, /params: \[formatNaira\(paidKobo\)/);
    assert.match(src, /\[id, user\.user_id, paidKobo,/);
    assert.doesNotMatch(src, /payoutMessage\(\{ amountKobo: s\.total_amount/);
  });
});
