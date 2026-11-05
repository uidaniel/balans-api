/** Monday's "who owes you" (5 November 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { weeklyOwedDue, weeklyOwedText, WEEKLY_OWED_BUTTONS } from "./weekly-owed.ts";
import { step } from "../conversation/machine.ts";
import { TEMPLATES } from "../whatsapp/window.ts";

const NOW = { y: 2026, m: 11, d: 9 };
const say = (text: string) => step("idle", {}, { text, today: NOW } as never, "5.2");

describe("when it goes", () => {
  it("is Monday from 9am in Lagos, and not before", () => {
    assert.equal(weeklyOwedDue(new Date("2026-11-09T08:00:00Z")), true); // 9am Lagos
    assert.equal(weeklyOwedDue(new Date("2026-11-09T07:30:00Z")), false); // 8:30am
    assert.equal(weeklyOwedDue(new Date("2026-11-10T09:00:00Z")), false); // Tuesday
  });
});

describe("what it says", () => {
  it("gives the total, the clients and the invoices, and how many are late", () => {
    const t = weeklyOwedText({ totalKobo: 450_000_00, clients: 2, invoices: 3, late: 1 });
    assert.match(t, /You're owed ₦450,000/);
    assert.match(t, /From 2 clients, on 3 unpaid invoices, 1 of them late/);
  });

  it("reads right for one", () => {
    const t = weeklyOwedText({ totalKobo: 50_000_00, clients: 1, invoices: 1, late: 1 });
    assert.match(t, /From 1 client, on 1 unpaid invoice, and it's late/);
  });

  it("has a utility template with the same two buttons", () => {
    const t = TEMPLATES.weekly_owed;
    assert.equal(t.category, "UTILITY");
    assert.deepEqual(t.quickReplies, WEEKLY_OWED_BUTTONS.map((x) => x.title));
  });
});

describe("its way out", () => {
  it("stops on the button, and starts again", () => {
    assert.deepEqual(say("Stop weekly updates").effects, [{ type: "set_weekly_owed", on: false }]);
    assert.deepEqual(say("start weekly").effects, [{ type: "set_weekly_owed", on: true }]);
  });
});

describe("the win-back (5 November 2026)", () => {
  it("offers the same invoice to their last client, and a way out", async () => {
    const { winBackText, winBackButtons } = await import("./win-back.ts");
    const { repeatAsked } = await import("../conversation/machine.ts");
    assert.match(winBackText("Zenith Homes"), /Need to bill Zenith Homes again\?/);
    const [again, stop] = winBackButtons("Zenith Homes");
    assert.deepEqual(repeatAsked(again!.id), { client: "Zenith Homes" });
    assert.deepEqual(say(stop!.id).effects, [{ type: "set_updates", on: false }]);
  });

  it("is marketing, honestly, with the same two buttons", () => {
    const t = TEMPLATES.win_back_again;
    assert.equal(t.category, "MARKETING");
    assert.deepEqual(t.quickReplies, ["Invoice them again", "Stop updates"]);
  });
});
