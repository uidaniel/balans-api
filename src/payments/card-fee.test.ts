/**
 * Balans's flat fee on a card from abroad (20 October 2026).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_INTL_PROCESSOR, settle } from "../../core/fees.ts";
import { defaults } from "../config.ts";
import { cardFeeKobo, NO_PERCENTAGE } from "./card-fee.ts";

const [y, m, d] = defaults.international.balansFeeFrom.split("-").map(Number) as [number, number, number];

describe("the card fee", () => {
  it("is ₦1,000 from its start date, and nothing before it", () => {
    assert.equal(cardFeeKobo({ y, m, d }), 1_000_00);
    assert.equal(cardFeeKobo({ y: y + 1, m: 1, d: 1 }), 1_000_00);
    const before = new Date(Date.UTC(y, m - 1, d - 1));
    assert.equal(cardFeeKobo({ y: before.getUTCFullYear(), m: before.getUTCMonth() + 1, d: before.getUTCDate() }), 0);
  });

  it("comes out of what the freelancer receives, never the client's charge", () => {
    const without = settle(500_000_00, NO_PERCENTAGE, { processor: DEFAULT_INTL_PROCESSOR });
    const withFee = settle(500_000_00, NO_PERCENTAGE, { processor: DEFAULT_INTL_PROCESSOR, flatFeeKobo: 1_000_00 });
    assert.equal(withFee.clientPaysKobo, without.clientPaysKobo);
    assert.equal(withFee.balansFeeKobo, 1_000_00);
    assert.equal(withFee.userReceivesKobo, without.userReceivesKobo - 1_000_00);
  });

  it("is not passed on with Paystack's fee", () => {
    const passed = settle(500_000_00, NO_PERCENTAGE, { processor: DEFAULT_INTL_PROCESSOR, passToClient: true, flatFeeKobo: 1_000_00 });
    assert.equal(passed.userReceivesKobo, 500_000_00 - 1_000_00);
  });

  it("never leaves a tiny payment owing", () => {
    const tiny = settle(1_000_00, NO_PERCENTAGE, { processor: DEFAULT_INTL_PROCESSOR, flatFeeKobo: 1_000_00 });
    assert.ok(tiny.userReceivesKobo >= 0);
    assert.ok(tiny.balansFeeKobo < 1_000_00);
  });

  it("is what Paystack is told to collect", () => {
    const route = readFileSync(new URL("../http/routes/public.ts", import.meta.url), "utf8");
    assert.match(route, /transactionChargeKobo: split\.balansFeeKobo/);
    assert.match(route, /flatFeeKobo: cardFeeKobo\(\)/);
  });

  it("raises the ceiling to about $2,500 an invoice", () => {
    assert.equal(defaults.international.invoiceCapMinor.USD, 2_500_00);
    assert.equal(defaults.international.invoiceCapMinor.GBP, 2_000_00);
  });
});
