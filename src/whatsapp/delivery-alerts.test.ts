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
    noteDeliveryFailures([failed(131049, "Message not delivered to maintain healthy ecosystem engagement")], log);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.msg, "WhatsApp message failed: Message not delivered to maintain healthy ecosystem engagement");
    assert.equal(logged[0]!.obj.to, "…1704");
  });

  it("keeps a phone that cannot take the message out of the error digest", () => {
    // 131026: not on WhatsApp, an old app, or blocked. Nothing on our side to fix.
    const errors: string[] = [];
    const warnings: string[] = [];
    const log = { error: (_o: unknown, msg: string) => errors.push(msg), warn: (_o: unknown, msg: string) => warnings.push(msg), info() {} } as never;
    noteDeliveryFailures([failed(131026, "Message undeliverable")], log);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, ["WhatsApp message failed: Message undeliverable"]);
  });
});
