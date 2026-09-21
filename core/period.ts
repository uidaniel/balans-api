/**
 * "How did I do this month?" -> a date range (PRD F15).
 *
 * Same split as amounts and due dates: the model reads words, this works out
 * the arithmetic. A summary that says "you invoiced ₦1.2m" had better be
 * adding up the right days, and which days those are is not a judgement call.
 *
 * Ranges are inclusive of both ends and expressed in civil dates, because a
 * month is a set of days and not a span of milliseconds.
 */

import { addDays, addMonths, compare, daysInMonth, weekdayOf, type Civil } from "./dates.ts";

export type Period = {
  from: Civil;
  to: Civil;
  /** How to name it back to the user: "this month", "March". */
  label: string;
};

const firstOf = (c: Civil): Civil => ({ ...c, d: 1 });
const lastOf = (c: Civil): Civil => ({ ...c, d: daysInMonth(c.y, c.m) });

// prettier-ignore
const MONTH_NAME = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];

/**
 * The week runs Monday to Sunday.
 *
 * Not Sunday-to-Saturday: a freelancer's "this week" is a working week, and a
 * Monday summary that already counts yesterday as this week is confusing.
 */
function startOfWeek(today: Civil): Civil {
  const dow = weekdayOf(today); // 0 = Sunday
  return addDays(today, -((dow + 6) % 7));
}

/**
 * Reads a period from a message. Returns null when none is named, which the
 * caller turns into the sensible default rather than guessing here.
 */
export function readPeriod(text: string, today: Civil): Period | null {
  const s = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;

  const thisMonth = { from: firstOf(today), to: lastOf(today), label: "this month" };

  if (/\b(this|current) month\b/.test(s) || /\bthis month\b/.test(s)) return thisMonth;

  if (/\blast month\b/.test(s) || /\bprevious month\b/.test(s)) {
    const prev = addMonths(firstOf(today), -1);
    return { from: firstOf(prev), to: lastOf(prev), label: "last month" };
  }

  if (/\bthis (week)\b/.test(s) || /\bthis working week\b/.test(s)) {
    const from = startOfWeek(today);
    return { from, to: addDays(from, 6), label: "this week" };
  }

  if (/\blast week\b/.test(s)) {
    const from = addDays(startOfWeek(today), -7);
    return { from, to: addDays(from, 6), label: "last week" };
  }

  if (/\b(today)\b/.test(s)) return { from: today, to: today, label: "today" };

  if (/\byesterday\b/.test(s)) {
    const d = addDays(today, -1);
    return { from: d, to: d, label: "yesterday" };
  }

  if (/\bthis year\b/.test(s)) {
    return { from: { y: today.y, m: 1, d: 1 }, to: { y: today.y, m: 12, d: 31 }, label: "this year" };
  }

  if (/\blast year\b/.test(s)) {
    const y = today.y - 1;
    return { from: { y, m: 1, d: 1 }, to: { y, m: 12, d: 31 }, label: String(y) };
  }

  // "in the last 30 days", "past 7 days".
  let m: RegExpExecArray | null;
  if ((m = /\b(?:last|past) (\d{1,3}) days\b/.exec(s))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 366) {
      return { from: addDays(today, -(n - 1)), to: today, label: `the last ${n} days` };
    }
  }

  // A month by name. "March" means this year's March unless it has not
  // happened yet, in which case they mean the one that has.
  if ((m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.exec(s))) {
    const month = MONTH_NAME.findIndex((n) => n.toLowerCase() === m![1]) + 1;
    const candidate = { y: today.y, m: month, d: 1 };
    const year = compare(candidate, today) > 0 ? today.y - 1 : today.y;
    const from = { y: year, m: month, d: 1 };
    return {
      from,
      to: lastOf(from),
      label: year === today.y ? MONTH_NAME[month - 1]! : `${MONTH_NAME[month - 1]} ${year}`,
    };
  }

  // "all time", for someone asking how they have done overall.
  if (/\b(all time|overall|so far|total|altogether|ever)\b/.test(s)) {
    return { from: { y: 2020, m: 1, d: 1 }, to: today, label: "all time" };
  }

  return null;
}

/** What a bare "summary" means (F15 leads with the month). */
export const defaultPeriod = (today: Civil): Period => ({
  from: firstOf(today),
  to: lastOf(today),
  label: "this month",
});
