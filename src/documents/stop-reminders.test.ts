/**
 * "stop reminders", as a reminder tells the sender to send it.
 *
 * On 4 October 2026 the due-date reminder said "Reply stop reminders to turn
 * these off for this invoice", and the reply said there was nothing to stop:
 * the 3- and 7-day reminders had not been written yet. The query is proved
 * against a real database in a rolled-back transaction; these pin the parts
 * that need none.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { asCommand } from "../parser/commands.ts";

const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const overdue = readFileSync(new URL("../jobs/overdue.ts", import.meta.url), "utf8");

describe("stop reminders", () => {
  it("reads 'stop reminders 3' as that invoice", () => {
    assert.deepEqual(asCommand("stop reminders 3"), { intent: "stop_reminders", documentNumber: 3 });
    assert.deepEqual(asCommand("Stop reminders #12"), { intent: "stop_reminders", documentNumber: 12 });
    assert.equal(asCommand("stop reminders")?.intent, "stop_reminders");
  });

  it("blocks the reminders not yet written, not only the pending ones", () => {
    const fn = actions.slice(actions.indexOf("export async function stopReminders"));
    assert.match(fn, /INSERT INTO reminders/);
    assert.match(fn, /'cancelled'/);
  });

  it("knows every kind the scheduler writes", () => {
    const kinds = [...overdue.slice(overdue.indexOf("export const SCHEDULE")).matchAll(/kind: "(\w+)"/g)]
      .slice(0, 3)
      .map((m) => m[1]);
    const declared = actions.match(/REMINDER_KINDS = \[([^\]]+)\]/)![1]!.match(/"(\w+)"/g)!.map((k) => k.slice(1, -1));
    assert.deepEqual(declared, kinds);
  });

  it("tells them the number to put in the reply", () => {
    assert.match(overdue, /`stop reminders \$\{x\.number\}`/);
  });
});

describe("asked before anything stops", () => {
  it("reads the two buttons, with and without a number", () => {
    assert.deepEqual(asCommand("yes stop reminders 3"), { intent: "confirm_stop_reminders", documentNumber: 3 });
    assert.deepEqual(asCommand("keep reminders 3"), { intent: "keep_reminders", documentNumber: 3 });
    assert.equal(asCommand("yes stop all reminders")?.intent, "confirm_stop_reminders");
    assert.equal(asCommand("keep reminders")?.intent, "keep_reminders");
  });

  it("does not stop anything on the first ask", () => {
    const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");
    const ask = handle.slice(handle.indexOf('if (effect.intent === "stop_reminders")'), handle.indexOf('if (effect.intent === "confirm_stop_reminders")'));
    assert.doesNotMatch(ask, /stopReminders\(/);
    assert.match(ask, /Yes, stop them/);
  });
});
