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
import { withinQuietHours, promptMessage, remindedHow } from "../jobs/overdue.ts";

describe("the templates we register with Meta", () => {
  const names = Object.keys(TEMPLATES) as TemplateName[];

  it("covers every template we register", () => {
    assert.deepEqual(
      [...names].sort(),
      [
        "client_invoice",
        "client_invoice_pdf",
        "client_quote",
        "client_quote_pdf",
        "client_reminded",
        "client_reminder",
        "invoice_overdue_prompt",
        "invoice_viewed",
        "launch_setup",
        "monthly_summary_ready",
        "payment_received",
        "payout_paid",
        "pro_active",
        "pro_ended_pay",
        "pro_ending_pay",
        "pro_free_pay",
        "pro_last_day_pay",
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

  it("is utility, not marketing, except the one message the waitlist asked for", () => {
    /*
     * Transactional messages are utility. Marketing costs about seven times
     * as much and needs opt-in — which the waitlist is: its form promises one
     * WhatsApp message the day Balans opens, and `launch_setup` is that
     * message. It is sent only from a broadcast, never from the bot.
     */
    for (const name of names) {
      assert.equal(TEMPLATES[name].category, name === "launch_setup" ? "MARKETING" : "UTILITY", name);
    }
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

describe("a reminder Balans sent for them", () => {
  /*
   * "Send them this — copy the message below" was the step that got
   * forgotten, which is the reason reminders exist at all. Where Balans can
   * reach the client itself it does, and the freelancer is told how.
   */
  const base = {
    number: 3,
    clientName: "Joshua Uwak",
    businessName: "Danny Codes Ltd",
    owedKobo: 1_350_000_00,
    due: { y: 2026, m: 9, d: 27 },
    today: { y: 2026, m: 9, d: 27 },
    link: "https://payment.balans.ng/i/abc",
  };

  it("says the client was reminded, and how, with nothing to copy", () => {
    const out = promptMessage({ ...base, reminded: { email: true, whatsapp: false } });
    assert.match(out, /Joshua Uwak has been reminded by email/);
    assert.doesNotMatch(out, /Send them this/, "still asking them to forward it");
    assert.doesNotMatch(out, /Hi Joshua Uwak/, "the client's message is still in the freelancer's chat");
  });

  it("names WhatsApp when that is how it went, and both when both did", () => {
    assert.match(promptMessage({ ...base, reminded: { email: false, whatsapp: true } }), /reminded on WhatsApp/);
    assert.match(
      promptMessage({ ...base, reminded: { email: true, whatsapp: true } }),
      /reminded by email and on WhatsApp/,
    );
  });

  it("falls back to the words to forward when neither could go", () => {
    const out = promptMessage({ ...base, reminded: { email: false, whatsapp: false } });
    assert.match(out, /Send them this/);
    assert.match(out, /Hi Joshua Uwak/);
  });

  it("describes the same reminder the same way in the chat and in the template", () => {
    assert.equal(remindedHow({ email: true, whatsapp: false }), "by email");
    assert.equal(remindedHow({ email: false, whatsapp: false }), null);
    assert.match(TEMPLATES.client_reminded.example[3]!, /by email|on WhatsApp/);
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
  it("does not call an invoice late on the day it is due", () => {
    // The first reminder goes on the due date, when the client still has the
    // whole day. "IS LATE ... was due today" said otherwise, to both of them.
    const onTheDay = promptMessage({
      number: 3,
      clientName: "Zenith Homes",
      businessName: "Kemi Adeyemi Studio",
      owedKobo: 350_000_00,
      due: { y: 2026, m: 9, d: 27 },
      today: { y: 2026, m: 9, d: 27 },
      link: "https://balans.ng/i/abc",
    });
    assert.match(onTheDay, /IS DUE TODAY/);
    assert.match(onTheDay, /is due today\./);
    assert.doesNotMatch(onTheDay, /LATE|was due/);
  });

  it("says a dollar invoice in dollars", () => {
    const abroad = promptMessage({
      number: 4,
      clientName: "Rajhni Williams",
      businessName: "Danny Codes Ltd",
      owedKobo: 664_480_00,
      owedAgreed: "$500.00",
      due: { y: 2026, m: 9, d: 28 },
      today: { y: 2026, m: 10, d: 1 },
      link: "https://balans.ng/i/abc",
    });
    assert.match(abroad, /\$500\.00/);
    assert.doesNotMatch(abroad, /₦664,480/);
  });
});
