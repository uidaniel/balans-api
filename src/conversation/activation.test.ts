/**
 * Getting people who finished setup to send something (5 November 2026):
 * the example, the way into a real invoice, and the one nudge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step } from "./machine.ts";
import { NUDGE_BUTTONS, nudgeText } from "../jobs/first-document.ts";
import { SAMPLE_LINES } from "../documents/sample.ts";

const NOW = { y: 2026, m: 11, d: 5 };
const say = (text: string) => step("idle", {}, { text, today: NOW } as never, "5.2");

describe("the example and the way in", () => {
  it("Try an example draws one, and nothing else", () => {
    assert.deepEqual(say("Try an example").effects, [{ type: "send_example" }]);
  });

  it("Create invoice opens the invoice form", () => {
    const fx = say("create invoice").effects;
    assert.equal(fx.length, 1);
    assert.equal(fx[0]!.type, "send_flow");
    assert.equal((fx[0] as { key: string }).key, "invoice");
  });

  it("the example is a made-up job, never a document", () => {
    assert.ok(SAMPLE_LINES.length >= 1);
    assert.ok(SAMPLE_LINES.every((l) => l.amountKobo === l.qty * l.unitAmountKobo));
  });
});

describe("the first-document nudge", () => {
  it("names the way in and the example, with both as buttons", () => {
    const t = nudgeText("Kemi Studio");
    assert.match(t, /Kemi Studio, your first invoice takes a minute/);
    assert.match(t, /Invoice Tunde 150k/);
    assert.deepEqual(NUDGE_BUTTONS.map((b) => b.id), ["create invoice", "try an example"]);
  });

  it("each button lands on a command the bot knows", () => {
    for (const b of NUDGE_BUTTONS) assert.ok(say(b.id).effects.length > 0, b.id);
  });
});
