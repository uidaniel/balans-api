/**
 * Step timings (3 November 2026): noted without waiting, and "reply.first"
 * once per message, from Meta's delivery to the first send accepted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromArrival, note, pendingTimings, sentReply, timed } from "./timing.ts";

const steps = () => pendingTimings().map((t) => t.step);

describe("step timings", () => {
  it("notes a step, and still notes it when the step fails", async () => {
    await timed("test.ok", async () => 1);
    await assert.rejects(timed("test.fail", async () => { throw new Error("x"); }));
    assert.ok(steps().includes("test.ok"));
    assert.ok(steps().includes("test.fail"));
  });

  it("counts the first reply once per message, and only inside one", async () => {
    sentReply(); // outside a message: nothing
    const before = steps().filter((s) => s === "reply.first").length;
    await fromArrival(async () => {
      sentReply();
      sentReply();
    });
    assert.equal(steps().filter((s) => s === "reply.first").length, before + 1);
  });

  it("ignores nonsense", () => {
    const n = pendingTimings().length;
    note("test.bad", -1);
    note("test.bad", Number.NaN);
    assert.equal(pendingTimings().length, n);
  });
});
