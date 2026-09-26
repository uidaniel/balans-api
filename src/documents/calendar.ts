/**
 * An invoice's due date, as something the client can put in their calendar.
 *
 * The point is the client, not the sender: an invoice that is not paid is
 * very often an invoice somebody meant to pay and forgot. A day in their own
 * calendar, with the payment link in it and a reminder the day before, is the
 * nudge that does not have to come from the freelancer.
 *
 * Invoices only. A quote is not owed, and a calendar entry saying "pay" for
 * one would be the product asking for money nobody has agreed to.
 *
 * Two forms of the same event. The invoice email carries it as an invitation
 * (`invite` below): that is what Gmail, Apple Mail and Outlook read to put an
 * event card at the top of the message with "Add to calendar" on it, the way
 * a delivery email grows a tracking card. Links in the body did the same job
 * worse — a line of text to notice, then a site to leave for. The same event
 * is also served as a plain file from the invoice's own address, and Google
 * Calendar can take it as a link.
 */

import type { Civil } from "../../core/dates.ts";

export type DueEvent = {
  /** Stable per invoice, so adding it twice updates rather than duplicates. */
  uid: string;
  business: string;
  /** Already formatted: "₦750,000". */
  amount: string;
  number: number | null;
  due: Civil;
  /** The payment page. */
  link: string;
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const day = (c: Civil): string => `${c.y}${pad(c.m)}${pad(c.d)}`;

/** The day after, for an all-day event's exclusive end. */
function next(c: Civil): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const title = (e: DueEvent): string => `Pay ${e.business} — ${e.amount}`;

const details = (e: DueEvent): string =>
  [
    `${e.number === null ? "Invoice" : `Invoice #${e.number}`} from ${e.business}, for ${e.amount}, is due today.`,
    "",
    `How to pay: ${e.link}`,
  ].join("\n");

export function googleCalendarUrl(e: DueEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: title(e),
    dates: `${day(e.due)}/${day(next(e.due))}`,
    details: details(e),
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** RFC 5545 text: backslash, semicolon, comma and newline are escaped. */
const text = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/**
 * Lines longer than 75 octets are folded: a CRLF and a space, then the rest.
 * Counted in bytes, and never through the middle of a character — "₦" is
 * three of them.
 */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/**
 * Who the event is from and who it is for, which is what makes it an
 * invitation rather than a file.
 *
 * A mail client shows its event card for METHOD:REQUEST with an organiser
 * and an attendee; a bare PUBLISH file is just an attachment. RSVP is off:
 * the point is the date in their calendar, not a "Tunde accepted" email
 * landing on the freelancer, and a client asked to accept or decline a bill
 * is being asked the wrong question.
 */
export type Invite = {
  organizer: { name: string; email: string };
  attendee: { name: string; email: string };
};

/** A name for a CN parameter: quoted, since a comma or colon would end it. */
const cn = (s: string): string => `"${s.replace(/["\r\n]/g, "")}"`;

export function icsFor(e: DueEvent, now = new Date(), invite?: Invite): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Balans//Invoice due date//EN",
      "CALSCALE:GREGORIAN",
      invite ? "METHOD:REQUEST" : "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${e.uid}@balans.ng`,
      `DTSTAMP:${stamp}`,
      ...(invite
        ? [
            "SEQUENCE:0",
            "STATUS:CONFIRMED",
            `ORGANIZER;CN=${cn(invite.organizer.name)}:mailto:${invite.organizer.email}`,
            `ATTENDEE;CN=${cn(invite.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${invite.attendee.email}`,
          ]
        : []),
      `DTSTART;VALUE=DATE:${day(e.due)}`,
      `DTEND;VALUE=DATE:${day(next(e.due))}`,
      `SUMMARY:${text(title(e))}`,
      `DESCRIPTION:${text(details(e))}`,
      `URL:${e.link}`,
      "TRANSP:TRANSPARENT",
      // 9 AM the day before (fifteen hours before the day starts): a reminder
      // on the day arrives after somebody has already planned it.
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${text(title(e))}`,
      "TRIGGER:-PT15H",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}
