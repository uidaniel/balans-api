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
    assert.match(payoutMessage({ amountKobo: 1_000_00, invoices: ["0002", "0003"], account: null }), /invoices 0002, 0003 has been sent to your bank account/);
  });
});
