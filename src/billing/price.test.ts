import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { proPriceForPhone, NAIRA_PRICE, chargedAs } = await import("./price.ts");
const { proOffer, proPayLabel } = await import("./messages.ts");

describe("the Pro price a person is shown and charged", () => {
  it("is the naira price in Nigeria", async () => {
    assert.deepEqual(await proPriceForPhone("2348012345678"), NAIRA_PRICE);
    assert.equal(chargedAs(NAIRA_PRICE), null);
  });

  const at2000 = (async () => ({ rate: 2000 })) as unknown as Parameters<typeof proPriceForPhone>[2];

  it("is their own price abroad, charged as naira at today's rate", async () => {
    const p = await proPriceForPhone("447700900123", undefined, at2000);
    assert.equal(p.abroad, true);
    assert.equal(p.label, "£4");
    assert.equal(p.chargeKobo, 4_00 * 2000);
    assert.match(proOffer(1, p), /£4/);
    assert.match(proOffer(1, p), /Charged as ₦8,000/);
    assert.equal(proPayLabel(p), "Pay Now");
  });

  it("falls back to the naira price when there is no rate", async () => {
    const none = (async () => null) as unknown as Parameters<typeof proPriceForPhone>[2];
    assert.deepEqual(await proPriceForPhone("447700900123", undefined, none), NAIRA_PRICE);
  });

  it("is five dollars where we have no local price", async () => {
    const p = await proPriceForPhone("8613800000000", undefined, at2000);
    assert.equal(p.label, "$5");
  });

  it("says the naira price when it was given nothing else", () => {
    assert.equal(proPayLabel(), "Pay Now");
  });
});
