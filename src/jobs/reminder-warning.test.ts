/** The sender hears before their client is reminded (5 November 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lateness, remindAt, warningHours, warningText, WARN_HOURS } from "./overdue.ts";
import { step } from "../conversation/machine.ts";
import { TEMPLATES } from "../whatsapp/window.ts";

const say = (text: string) => step("idle", {}, { text, today: { y: 2026, m: 11, d: 5 } } as never, "5.2");

describe("the warning before a reminder", () => {
  it("says who, how much, and when the reminder goes", () => {
    const t = warningText({ client: "Zenith Homes", number: 12, owed: "₦350,000", when: "due today", at: "2pm" });
    assert.match(t, /Zenith Homes's invoice #12 is due today/);
    assert.match(t, /I'll remind them at about \*2pm\* unless you tell me they've paid/);
  });

  it("gives the sender three hours, named in Lagos time", () => {
    assert.equal(WARN_HOURS, 3);
    assert.equal(remindAt(new Date("2026-11-05T08:00:00Z")), "12pm"); // 9am Lagos + 3h
    assert.equal(remindAt(new Date("2026-11-05T12:00:00Z")), "4pm");
  });

  it("goes only in the working day, so the reminder lands before the quiet hours", () => {
    assert.equal(warningHours(new Date("2026-11-05T07:00:00Z")), true); // 8am
    assert.equal(warningHours(new Date("2026-11-05T15:59:00Z")), true); // 4:59pm
    assert.equal(warningHours(new Date("2026-11-05T16:00:00Z")), false); // 5pm
    assert.equal(warningHours(new Date("2026-11-05T06:00:00Z")), false); // 7am
  });

  it("says how late it is", () => {
    const today = { y: 2026, m: 11, d: 5 };
    assert.equal(lateness({ y: 2026, m: 11, d: 5 }, today), "due today");
    assert.equal(lateness({ y: 2026, m: 11, d: 4 }, today), "1 day late");
    assert.equal(lateness({ y: 2026, m: 11, d: 2 }, today), "3 days late");
  });

  it("has a utility template with Already paid and Remind them now", () => {
    const t = TEMPLATES.reminder_heads_up;
    assert.equal(t.category, "UTILITY");
    assert.deepEqual(t.quickReplies, ["Already paid", "Remind them now"]);
    assert.equal(t.params.length, 5);
  });

  it("Remind them now is understood", () => {
    assert.deepEqual(say("remind now 12").effects, [{ type: "remind_now", number: 12 }]);
  });
});
