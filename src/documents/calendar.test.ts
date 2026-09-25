/**
 * The due date as a calendar event, for the client (invoices only).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { googleCalendarUrl, icsFor, type DueEvent } from "./calendar.ts";
import { calendarLine } from "../email/client-delivery.ts";

const e: DueEvent = {
  uid: "doc-1",
  business: "Danny Codes LTD",
  amount: "₦750,000",
  number: 6,
  due: { y: 2026, m: 12, d: 31 },
  link: "https://payment.balans.ng/i/abc",
};

describe("the calendar event", () => {
  it("is an all-day event on the due date, ending the day after", () => {
    const ics = icsFor(e, new Date("2026-09-25T10:00:00Z"));
    assert.match(ics, /DTSTART;VALUE=DATE:20261231\r\n/);
    // Across the year end, which is where a hand-rolled "+1" breaks.
    assert.match(ics, /DTEND;VALUE=DATE:20270101\r\n/);
  });

  it("carries the payment link and a reminder the day before", () => {
    const ics = icsFor(e);
    assert.match(ics, /URL:https:\/\/payment\.balans\.ng\/i\/abc/);
    assert.match(ics, /TRIGGER:-PT15H/);
    assert.match(ics, /UID:doc-1@balans\.ng/, "stable, so adding it twice does not make two");
  });

  it("is valid iCalendar text: CRLF lines, escaped commas, folded at 75 octets", () => {
    const ics = icsFor({ ...e, business: "Ada, Bola; and Co" });
    assert.ok(!/[^\r]\n/.test(ics), "every line ends CRLF");
    assert.ok(ics.includes("Ada\\, Bola\\; and Co"), "commas and semicolons escaped");
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  });

  it("opens Google Calendar filled in", () => {
    const u = new URL(googleCalendarUrl(e));
    assert.equal(u.hostname, "calendar.google.com");
    assert.equal(u.searchParams.get("dates"), "20261231/20270101");
    assert.match(u.searchParams.get("text") ?? "", /Pay Danny Codes LTD — ₦750,000/);
    assert.match(u.searchParams.get("details") ?? "", /payment\.balans\.ng\/i\/abc/);
  });

  it("offers both in the email, escaped", () => {
    const line = calendarLine(e, `${e.link}/calendar.ics`);
    assert.match(line, /Google Calendar/);
    assert.match(line, /href="https:\/\/payment\.balans\.ng\/i\/abc\/calendar\.ics"/);
    assert.match(line, /&amp;/, "the URL's own ampersands, escaped in the attribute");
  });
});
