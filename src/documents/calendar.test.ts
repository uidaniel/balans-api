/**
 * The due date as a calendar event, for the client (invoices only).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { googleCalendarUrl, icsFor, type DueEvent } from "./calendar.ts";
import { dueInvite } from "../email/client-delivery.ts";

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

  it("goes in the email as an invitation, which is what draws the card", () => {
    const att = dueInvite(
      e,
      { name: "Danny Codes LTD", email: "danny@x.ng" },
      { name: "Tunde Olamide", email: "tunde@y.ng" },
      new Date("2026-09-25T10:00:00Z"),
    )!;
    assert.equal(att.filename, "invite.ics");
    assert.equal(att.contentType, "text/calendar; charset=utf-8; method=REQUEST");
    const ics = att.content.toString("utf8");
    assert.match(ics, /METHOD:REQUEST\r\n/);
    assert.match(ics, /ORGANIZER;CN="Danny Codes LTD":mailto:danny@x\.ng/);
    // Unfolded first: the attendee line is long enough to be folded.
    const flat = ics.replace(/\r\n /g, "");
    assert.match(flat, /ATTENDEE;CN="Tunde Olamide";[^\r]*RSVP=FALSE:mailto:tunde@y\.ng/);
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  });

  it("stays a plain file when it is not being sent to anyone", () => {
    const ics = icsFor(e);
    assert.match(ics, /METHOD:PUBLISH/);
    assert.doesNotMatch(ics, /ORGANIZER|ATTENDEE/);
  });

  it("is not sent without an organiser to send it from", () => {
    assert.equal(dueInvite(e, { name: "X", email: null }, { name: "Y", email: "y@z.ng" }), null);
  });
});
