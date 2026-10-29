/**
 * Getting people to Pro on time (20 October 2026): the yearly price first,
 * the branded limit card, the one email to the quiet, and the chat line.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { lastFreeLeft, proHeadline, proNudge } from "./messages.ts";
import { NAIRA_PRICE, NAIRA_YEAR_PRICE, perMonthOf } from "./price.ts";
import { limitCardHtml } from "./limit-card.ts";
import { trialUsedEmail } from "../email/send.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the yearly plan leads", () => {
  it("says the year a month at a time, and only in naira", () => {
    assert.equal(perMonthOf(NAIRA_YEAR_PRICE), "₦2,500");
    assert.equal(perMonthOf(NAIRA_PRICE), null);
    assert.equal(perMonthOf({ ...NAIRA_YEAR_PRICE, abroad: true }), null);
  });

  it("falls back to the month alone when there is no year to offer", () => {
    assert.match(proHeadline(NAIRA_PRICE), /₦3,000\* a month/);
  });
});

describe("the branded limit card", () => {
  it("says it is theirs and carries their invoice", () => {
    const html = limitCardHtml(Buffer.from("png"), 3);
    assert.match(html, /This is yours\.<\/span><span class="m">Keep sending it\./);
    assert.match(html, /Your three free documents are used/);
    assert.match(html, /data:image\/png;base64,/);
    // The month's own price, with the year beside it (29 October 2026).
    assert.match(html, /<span class="ngn">N<\/span>3,000<\/p><p class="per">a month, or <span class="ngn">N<\/span>30,000 a year/);
  });
});

describe("the email to the quiet", () => {
  const email = trialUsedEmail({
    businessName: "Ada Studio",
    allowance: 3,
    card: null,
    yearLabel: "₦30,000",
    perMonth: "₦2,500",
    monthLabel: "₦3,000",
    yearUrl: "https://api.example/pro/start?t=x&term=year",
    monthUrl: "https://api.example/pro/start?t=x&term=month",
  });

  it("is an account notice: what still works, then how to keep sending", () => {
    assert.match(email.text, /Everything you sent still works/);
    assert.match(email.text, /₦2,500 a month on the yearly plan/);
    assert.match(email.text, /This is the only email about it/);
    assert.match(email.html!, /Go yearly, ₦2,500\/month/);
  });

  it("is sent once: marked before the send, two quiet days after the last free document", () => {
    const job = src("../jobs/trial-notices.ts");
    assert.match(job, /UPDATE users u SET trial_notice_at = now\(\)/);
    assert.match(job, /trial_notice_at IS NULL/);
    assert.match(job, /last_inbound_at, '-infinity'\) < now\(\) - interval '2 days'/);
    assert.match(src("../jobs/overdue.ts"), /await sendTrialNotices\(log\)/);
  });
});

describe("the line in the chat", () => {
  it("names the yearly price", () => {
    assert.match(proNudge(3, "₦2,500"), /Your 3 free documents are used\. Reply \*upgrade\* to keep sending, from ₦2,500 a month/);
    assert.match(lastFreeLeft("₦2,500"), /1 free document left/);
  });

  it("is claimed in the database, at most once every three days", () => {
    const handle = src("../conversation/handle.ts");
    assert.match(handle, /pro_nudged_at < now\(\) - interval '3 days'/);
    assert.match(handle, /NO_PRO_NUDGE/);
  });
});

describe("message text is purged", () => {
  it("runs with the daily jobs, as the privacy policy says", () => {
    assert.match(src("../jobs/overdue.ts"), /purgeParserText\(defaults\.behaviour\.parserTextRetentionDays\)/);
    assert.match(src("../jobs/trial-notices.ts"), /SET text = NULL/);
  });
});
