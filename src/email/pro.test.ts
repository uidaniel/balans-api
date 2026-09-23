/**
 * The Pro email: a welcome the first month, a receipt every month after.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proEmail } from "./send.ts";

const base = {
  businessName: "Kemi Adeyemi Studio",
  first: true,
  amountKobo: 4_000_00,
  until: new Date("2026-10-23T12:00:00Z"),
  waNumber: "2348000000000",
};

describe("the Pro email", () => {
  it("welcomes the first month, with the banner it attaches", () => {
    const m = proEmail(base);
    assert.equal(m.subject, "You're on Balans Pro");
    assert.equal(m.images?.[0]?.cid, "pro-banner");
    assert.match(m.html!, /src="cid:pro-banner"/);
    assert.match(m.html!, /Put your logo on your invoices/);
  });

  it("states what was paid and until when, in both parts", () => {
    const m = proEmail(base);
    for (const part of [m.html!, m.text]) {
      assert.match(part, /₦4,000/);
      assert.match(part, /23 October 2026/);
    }
  });

  it("is only a receipt on a renewal", () => {
    const m = proEmail({ ...base, first: false });
    assert.equal(m.subject, "Balans Pro renewed until 23 October 2026");
    assert.equal(m.images, undefined);
    assert.doesNotMatch(m.html!, /Put your logo/);
  });

  it("never claims it renews by itself", () => {
    // It does not: they are reminded, and pay again.
    for (const first of [true, false]) {
      const m = proEmail({ ...base, first });
      assert.doesNotMatch(m.html! + m.text, /renews automatically|will be charged/i);
      assert.match(m.text, /three days before it ends/);
    }
  });

  it("escapes the business name", () => {
    const m = proEmail({ ...base, businessName: "<i>Kemi</i>" });
    assert.match(m.html!, /&lt;i&gt;Kemi&lt;\/i&gt; is on Pro/);
  });
});
