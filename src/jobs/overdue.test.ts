/**
 * Catching up on reminders (24 October 2026).
 *
 * An invoice due 3 October came back into the schedule on 24 October, when
 * Pro was switched on again, and the client got the 3-day and the 7-day
 * reminders in the same minute. Only the latest step that is due goes out;
 * the ones it passed are written as cancelled, so they count as done.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SCHEDULE } from "./overdue.ts";

const source = readFileSync(new URL("./overdue.ts", import.meta.url), "utf8");
const schedule = source.slice(source.indexOf("export async function scheduleReminders"), source.indexOf("export async function sendDueReminders"));

describe("scheduling reminders that were missed", () => {
  it("runs in the order of the schedule, each step knowing the next", () => {
    assert.deepEqual(SCHEDULE.map((s) => s.daysAfterDue), [0, 3, 7]);
    assert.match(schedule, /for \(const \[i, step\] of SCHEDULE\.entries\(\)\)/);
    assert.match(schedule, /const next = SCHEDULE\[i \+ 1\];/);
  });

  it("writes a step as cancelled when the next one is due too, for this invoice's plan", () => {
    assert.match(schedule, /AND d\.due_date \+ \(\$5::int \|\| ' days'\)::interval <= \$1::date/);
    assert.match(schedule, /AND \(\$6::boolean = false OR balans_doc_pro\(d, u\)\)/);
    assert.match(schedule, /THEN 'cancelled' ELSE 'pending' END/);
    assert.match(schedule, /next\?\.daysAfterDue \?\? null, next\?\.proOnly \?\? false/);
  });
});

describe("asking whether they were paid (31 October 2026)", async () => {
  const { promptMessage } = await import("./overdue.ts");
  const { asCommand } = await import("../parser/commands.ts");
  const base = {
    number: 16,
    clientName: "Zenith",
    businessName: "Kemi Studio",
    owedKobo: 50_000_00,
    due: { y: 2026, m: 10, d: 30 },
    today: { y: 2026, m: 11, d: 2 },
    link: null,
  };

  it("says what the buttons under it are for", () => {
    const m = promptMessage({ ...base, reminded: { email: true, whatsapp: false }, askPaid: true });
    assert.match(m, /Has Zenith paid\?/);
    assert.match(m, /once it is in your bank/);
  });

  it("says nothing about them when there are none", () => {
    assert.doesNotMatch(promptMessage({ ...base, reminded: { email: true, whatsapp: false } }), /Has Zenith paid/);
  });

  it("reads the buttons' ids as the commands they stand for", () => {
    assert.equal(asCommand("not yet 16")?.intent, "not_paid_yet");
    assert.equal(asCommand("yes mark invoice 16 paid")?.intent, "confirm_payment");
    assert.equal(asCommand("mark invoice 16 as paid")?.intent, "record_payment");
  });
});
