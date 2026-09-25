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
 * Two forms of the same event. Google Calendar takes a link that opens the
 * event already filled in. Apple Calendar and Outlook take an .ics file,
 * which is served from the invoice's own address rather than attached, so a
 * client can add it from the email without hunting for an attachment.
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
    `Pay online: ${e.link}`,
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

export function icsFor(e: DueEvent, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Balans//Invoice due date//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${e.uid}@balans.ng`,
      `DTSTAMP:${stamp}`,
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
