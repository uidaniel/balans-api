/**
 * Accepted by Meta, then not delivered (4 November 2026): logged as an error,
 * and a billing failure raises its own alert.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { failuresIn, isPaymentFailure, noteDeliveryFailures } from "./delivery-alerts.ts";

const failed = (code: number, title: string) => ({
  type: "status.failed",
  payload: { status: { id: "wamid.x", status: "failed", recipient_id: "2348000001704", errors: [{ code, title }] } },
});

describe("delivery failures", () => {
  it("reads Meta's reason from a failed report, and ignores the rest", () => {
    const out = failuresIn([failed(131042, "Business eligibility payment issue"), { type: "status.delivered", payload: {} }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 131042);
    assert.ok(isPaymentFailure(out[0]!));
    assert.ok(!isPaymentFailure({ code: 131026, title: "Message undeliverable", recipient: null }));
  });

  it("logs each failure as an error, with only the number's last digits", () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    const log = { error: (obj: Record<string, unknown>, msg: string) => logged.push({ obj, msg }), warn() {}, info() {} } as never;
    noteDeliveryFailures([failed(131026, "Message undeliverable")], log);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.msg, "WhatsApp message failed: Message undeliverable");
    assert.equal(logged[0]!.obj.to, "…1704");
  });
});
