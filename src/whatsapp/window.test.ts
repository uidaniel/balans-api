/**
 * The 24-hour window and the templates that survive it.
 *
 * These are the rules that decide whether the most important message in the
 * product arrives at all, and every one of them fails silently when wrong: a
 * bad template name or a wrong parameter count is refused by Meta, not by us.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { costOf, MESSAGE_COST_KOBO, TEMPLATES, type TemplateName } from "./window.ts";
import { withinQuietHours, promptMessage } from "../jobs/overdue.ts";

describe("the templates we register with Meta", () => {
  const names = Object.keys(TEMPLATES) as TemplateName[];

  it("covers the six F16 names, and the two that reach a client", () => {
    assert.deepEqual(
      [...names].sort(),
      [
        "client_invoice",
        "client_quote",
        "invoice_overdue_prompt",
        "invoice_viewed",
        "monthly_summary_ready",
        "payment_received",
        "pro_renewal",
        "security_alert",
      ],
    );
  });

  it("declares a parameter for every placeholder, and no more", () => {
    // A mismatch is rejected at send time. Counting them here is the only way
    // to find out before a real message fails.
    for (const name of names) {
      const t = TEMPLATES[name];
      const placeholders = new Set(t.body.match(/\{\{(\d+)\}\}/g) ?? []);
      assert.equal(
        placeholders.size,
        t.params.length,
        `${name}: ${placeholders.size} placeholders, ${t.params.length} params declared`,
      );
      assert.equal(t.example.length, t.params.length, `${name}: example does not match params`);
    }
  });

  it("numbers placeholders from 1 with no gaps", () => {
    // Meta matches positionally, so {{1}},{{3}} silently shifts everything.
    for (const name of names) {
      const t = TEMPLATES[name];
      const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      const expected = Array.from({ length: t.params.length }, (_, i) => i + 1);
      assert.deepEqual([...new Set(nums)].sort((a, b) => a - b), expected, name);
    }
  });

  it("uses its own name as the key, so a lookup cannot drift", () => {
    for (const name of names) assert.equal(TEMPLATES[name].name, name);
  });

  it("is written as a whole sentence, not a fragment", () => {
    // A template is what a user reads with no context around it.
    for (const name of names) {
      const t = TEMPLATES[name];
      assert.ok(t.body.length > 40, `${name} is too terse to stand alone`);
      assert.match(t.body, /[.!?]$/, `${name} does not end as a sentence`);
      assert.ok(!t.body.startsWith("{{"), `${name} opens with a placeholder`);
    }
  });

  it("is utility, not marketing", () => {
    // These are all transactional. Marketing costs more and needs opt-in.
    for (const name of names) assert.equal(TEMPLATES[name].category, "UTILITY", name);
  });
});

describe("what a message costs", () => {
  it("charges the service rate inside the window", () => {
    assert.equal(costOf({ inWindow: true }), MESSAGE_COST_KOBO.service);
    // The category is irrelevant inside the window.
    assert.equal(costOf({ inWindow: true, category: "MARKETING" }), MESSAGE_COST_KOBO.service);
  });

  it("charges the template rate outside it", () => {
    assert.equal(costOf({ inWindow: false, category: "UTILITY" }), MESSAGE_COST_KOBO.utility);
    assert.equal(costOf({ inWindow: false, category: "MARKETING" }), MESSAGE_COST_KOBO.marketing);
  });

  it("treats an unnamed category as utility, the cheaper guess", () => {
    assert.equal(costOf({ inWindow: false }), MESSAGE_COST_KOBO.utility);
  });
});

describe("quiet hours", () => {
  // F13: "No reminders between 8pm and 8am Africa/Lagos." Lagos is UTC+1 all
  // year, so these UTC instants map straight onto Lagos wall-clock time.
  const at = (utcHour: number) => new Date(Date.UTC(2026, 8, 23, utcHour, 30));

  it("is quiet from 8pm", () => {
    assert.equal(withinQuietHours(at(19)), true, "20:30 Lagos");
    assert.equal(withinQuietHours(at(22)), true, "23:30 Lagos");
    assert.equal(withinQuietHours(at(2)), true, "03:30 Lagos");
    assert.equal(withinQuietHours(at(6)), true, "07:30 Lagos");
  });

  it("is awake from 8am", () => {
    assert.equal(withinQuietHours(at(7)), false, "08:30 Lagos");
    assert.equal(withinQuietHours(at(11)), false, "12:30 Lagos");
    assert.equal(withinQuietHours(at(18)), false, "19:30 Lagos");
  });

  it("goes by Lagos, not by the server", () => {
    // 21:30 UTC is 22:30 in Lagos: quiet there, whatever the host thinks.
    assert.equal(withinQuietHours(at(21)), true);
    // And 06:30 UTC is 07:30 Lagos, still quiet, though much of the world is up.
    assert.equal(withinQuietHours(at(6)), true);
  });
});

describe("the reminder prompt", () => {
  const prompt = promptMessage({
    number: 14,
    clientName: "Zenith Homes",
    businessName: "Kemi Adeyemi Studio",
    owedKobo: 350_000_00,
    due: { y: 2026, m: 9, d: 18 },
    today: { y: 2026, m: 9, d: 23 },
    link: "https://balans.ng/i/abc",
  });

  it("says what is owed, by whom, and when it was due", () => {
    assert.match(prompt, /₦350,000/);
    assert.match(prompt, /Zenith Homes/);
    assert.match(prompt, /#14/);
    assert.match(prompt, /Fri, 18 Sep/);
  });

  it("includes something ready to forward, with the link in it", () => {
    assert.match(prompt, /Send them this/i);
    assert.match(prompt, /https:\/\/balans\.ng\/i\/abc/);
  });

  it("is neutral, as the design system requires", () => {
    // Most late invoices are forgotten, not refused. A sharp reminder costs a
    // client relationship worth more than the invoice.
    assert.doesNotMatch(prompt, /overdue|late payment|failed to pay|owe us|chase|debt|demand/i);
    assert.match(prompt, /just a note|thank you/i);
  });

  it("offers a way to turn them off", () => {
    assert.match(prompt, /stop reminders/i);
  });

  it("works with no link and no number", () => {
    const bare = promptMessage({
      number: null,
      clientName: "Tunde",
      businessName: "us",
      owedKobo: 20_000_00,
      due: { y: 2026, m: 9, d: 18 },
      today: { y: 2026, m: 9, d: 23 },
      link: null,
    });
    assert.match(bare, /the invoice/);
    assert.doesNotMatch(bare, /null|undefined/);
  });
});
