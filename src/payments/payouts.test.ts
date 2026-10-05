import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { payoutMessage } from "./payouts.ts";

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
