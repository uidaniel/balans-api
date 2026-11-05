/**
 * After an invoice goes out: the invoice, then one message (2 November 2026).
 *
 * It was up to four bubbles: the invoice, the logo, the free documents with a
 * Pro line, the email. Now the follow-up carries what is left as a quiet line
 * and buttons, and the Pro line about late payers waits for a real reminder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { step, VOICE } from "./machine.ts";

const NOW = { y: 2026, m: 11, d: 2 };
const handle = readFileSync(new URL("./handle.ts", import.meta.url), "utf8");
const overdue = readFileSync(new URL("../jobs/overdue.ts", import.meta.url), "utf8");

describe("the buttons under the first invoice", () => {
  it("Add my email asks for it", () => {
    const out = step("idle", {}, { text: "add my email", today: NOW } as never, "5.0");
    assert.deepEqual(out.replies, [VOICE.askEmail]);
  });

  it("Add my logo sends the brand settings link", () => {
    const out = step("idle", {}, { text: "add my logo", today: NOW } as never, "5.0");
    assert.deepEqual(out.effects, [{ type: "offer_branding" }]);
  });
});

describe("what follows a sent invoice", () => {
  it("is one follow-up, not three messages", () => {
    assert.match(handle, /await followUp\(\);/);
    assert.doesNotMatch(handle, /await trialNote\(\)|await askEmail\(\)|await remindBank\(\)/);
    // The logo is a button on the follow-up, not its own message, on the first.
    assert.doesNotMatch(handle, /offerBranding\(userId, ctx\.phone, "first_send", log\)/);
  });

  it("puts no Pro line under a reminder (5 November 2026)", () => {
    assert.doesNotMatch(overdue, /Chasing late payers is a Pro feature/);
  });
});
