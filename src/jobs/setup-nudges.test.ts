/**
 * Somebody who started setting up and stopped (30 October 2026): one nudge in
 * the chat a few hours on, one follow-up two days on, and nothing after.
 *
 * Who gets one, and that nobody gets two, lives in SQL; what is checked here
 * is that the SQL says so, and that the words point the right way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { nudgeText } from "./setup-nudges.ts";
import { setupReminderEmail } from "../email/send.ts";
import { TEMPLATES } from "../whatsapp/window.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const job = src("./setup-nudges.ts");

describe("the nudge in the chat", () => {
  it("offers the form again to somebody who stopped on it", () => {
    const text = nudgeText("onboarding:form", true);
    assert.match(text, /Your Balans setup is nearly done/);
    assert.match(text, /Tap below to finish/);
  });

  it("asks for the business name in words when there is no form to send", () => {
    const text = nudgeText("onboarding:form", false);
    assert.match(text, /Send the name your clients would recognise/);
    assert.doesNotMatch(text, /Tap below/);
  });

  it("repeats the question somebody typing stopped on", () => {
    assert.match(nudgeText("onboarding:bank", false), /bank and account number together/);
    assert.match(nudgeText("onboarding:verify_email", false), /6-digit code/);
    assert.match(nudgeText("onboarding:consent", false), /I agree/);
  });

  it("is claimed before it is sent, once, and only while the window is open", () => {
    assert.match(job, /UPDATE users u SET setup_nudge_at = now\(\)/);
    assert.match(job, /u\.setup_nudge_at IS NULL/);
    assert.match(job, /c\.last_inbound_at BETWEEN now\(\) - interval '20 hours' AND now\(\) - interval '3 hours'/);
    assert.match(job, /windowFor\(r\.id\)\)\.open/);
  });
});

describe("the follow-up two days on", () => {
  it("is claimed before it is sent, once, between two days and two weeks", () => {
    assert.match(job, /UPDATE users u SET setup_followup_at = now\(\)/);
    assert.match(job, /u\.setup_followup_at IS NULL/);
    assert.match(job, /BETWEEN now\(\) - interval '14 days' AND now\(\) - interval '2 days'/);
  });

  it("only uses an address that was proved, or given to the waitlist and not unsubscribed", () => {
    assert.match(job, /CASE WHEN u\.email_verified_at IS NOT NULL THEN u\.email END/);
    assert.match(job, /w\.unsubscribed_at IS NULL/);
  });

  it("leaves somebody it cannot reach unmarked until the template is approved", () => {
    assert.match(job, /WHERE \$1::boolean OR email IS NOT NULL/);
  });

  it("never touches anybody who finished", () => {
    assert.equal((job.match(/u\.activated_setup_at IS NULL/g) ?? []).length, 2);
  });
});

describe("the template", () => {
  const t = TEMPLATES.setup_reminder;

  it("opens the setup form, and says why they have it", () => {
    // About their own account, so utility: marketing needs an opt-in they never gave.
    assert.equal(t.category, "UTILITY");
    assert.deepEqual(t.flowButton, { text: "Finish setup", flow: "onboarding", screen: "BUSINESS" });
    assert.ok(t.footer && t.footer.length <= 60, "Meta caps a footer at 60 characters");
    assert.deepEqual(t.params, []);
    assert.doesNotMatch(t.body, /\{\{\d\}\}/);
  });

  it("is about their setup and nothing else", () => {
    assert.match(t.body, /Your Balans account setup is not finished yet/);
    assert.doesNotMatch(t.body, /paid with Balans|Balans pays|free|Pro/i);
  });
});

describe("the email", () => {
  it("sends them back to the chat", () => {
    const e = setupReminderEmail({ businessName: "Kemi Studio", waNumber: "2348000000000" });
    assert.equal(e.subject, "Your Balans setup is almost done");
    assert.match(e.html ?? "", /Kemi Studio is nearly set up/);
    assert.match(e.html ?? "", /https:\/\/wa\.me\/2348000000000/);
    assert.match(e.text, /This is the only email about it/);
  });

  it("still makes sense without our number", () => {
    const e = setupReminderEmail({ businessName: null, waNumber: null });
    assert.doesNotMatch(e.html ?? "", /wa\.me/);
    assert.match(e.text, /Open your WhatsApp chat with Balans to finish/);
  });
});

describe("where it runs", () => {
  it("runs with the hourly jobs, never in quiet hours", () => {
    const overdue = src("./overdue.ts");
    assert.match(overdue, /if \(!withinQuietHours\(\)\) \{\s*await sendSetupNudges\(log\);\s*await sendSetupFollowups\(log\);/);
  });

  it("has somewhere to keep both stamps", () => {
    const sql = src("../db/migrations/0050_setup_nudges.sql");
    assert.match(sql, /ADD COLUMN setup_nudge_at TIMESTAMPTZ/);
    assert.match(sql, /ADD COLUMN setup_followup_at TIMESTAMPTZ/);
  });
});
