/** Pro notices Meta files as marketing go by email (19 November 2026). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { waToHtml } from "./notice-route.ts";

describe("a Pro notice as an email", () => {
  it("keeps WhatsApp's bold and paragraphs, and escapes the rest", () => {
    const h = waToHtml("⭐ *Your Pro ends tomorrow.*\nIt does not renew by itself.\n\nTap below <now>.");
    assert.match(h, /<strong>Your Pro ends tomorrow\.<\/strong><br>It does not renew by itself\./);
    assert.match(h, /Tap below &lt;now&gt;\./);
  });
});

describe("where the routing is wired", () => {
  const overdue = readFileSync(new URL("../jobs/overdue.ts", import.meta.url), "utf8");
  const notify = readFileSync(new URL("../payments/notify.ts", import.meta.url), "utf8");
  it("Pro reminders check the window and Meta's category before a template", () => {
    assert.match(overdue, /!\(await windowFor\(r\.userId\)\)\.open && \(await marketingWouldBeUsed\(candidates\)\)/);
    assert.match(overdue, /if \(stage === "win_back"\) continue;/);
  });
  it("so does the notice that Pro is active", () => {
    assert.match(notify, /marketingWouldBeUsed\(\["pro_plan_active", "pro_active"\]\)/);
  });
});
