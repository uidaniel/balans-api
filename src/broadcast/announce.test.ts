/**
 * Messages to every user (3 November 2026): what WhatsApp and email carry,
 * and the ways to stop them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { announcementEmail, announcementText, oneParagraph, STOP_LINE } from "./announce.ts";
import { step } from "../conversation/machine.ts";
import { TEMPLATES } from "../whatsapp/window.ts";

const NOW = { y: 2026, m: 11, d: 3 };

describe("an announcement", () => {
  it("runs onto one line for the template, which cannot hold a line break", () => {
    assert.equal(oneParagraph("New this month.\n\nYour statement   by email."), "New this month. Your statement by email.");
  });

  it("says how to stop, on WhatsApp and in the template", () => {
    assert.ok(announcementText("Hello").endsWith(`_${STOP_LINE}_`));
    assert.match(TEMPLATES.announcement.body, /Reply STOP UPDATES/);
    assert.equal(TEMPLATES.announcement.category, "MARKETING");
  });

  it("emails with a stop link that only works for that user", () => {
    const e = announcementEmail({ subject: "News", message: "One.\n\nTwo.", userId: "11111111-1111-4111-8111-111111111111" });
    assert.equal(e.subject, "News");
    assert.match(e.html!, /\/updates\/stop\?u=11111111-1111-4111-8111-111111111111&amp;t=[0-9a-f]{32}/);
    assert.match(e.html!, /Your invoices and receipts are not affected/);
  });

  it("STOP UPDATES and START UPDATES turn it off and on", () => {
    assert.deepEqual(step("idle", {}, { text: "STOP UPDATES", today: NOW } as never, "5.0").effects, [{ type: "set_updates", on: false }]);
    assert.deepEqual(step("idle", {}, { text: "start updates", today: NOW } as never, "5.0").effects, [{ type: "set_updates", on: true }]);
  });
});
