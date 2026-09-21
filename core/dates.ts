/**
 * Relative due dates -> a calendar date in Africa/Lagos (PRD F3).
 *
 * The model reads "due Friday" and hands back the phrase. This resolves it.
 * That split is the same one `parseAmountToKobo` makes, and for the same
 * reason: a due date decides when someone is chased for money, so it is
 * arithmetic, not judgement, and it belongs somewhere with a test table.
 *
 * Everything here works on the civil calendar — year, month, day — and never
 * on an instant. A `Date` is only used as a convenient calendar, through its
 * UTC accessors, so no timezone offset ever enters the arithmetic. Nigeria has
 * never observed daylight saving, but a due date is the day written on an
 * invoice, not a moment, so the offset should not be in the sum either way.
 */

/** A civil date, as it would be written on the invoice. */
export type Civil = { y: number; m: number; d: number };

const DAY_MS = 86_400_000;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/** Counting words, because people write "in two weeks" far more than "in 2". */
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1,
  couple: 2, two: 2,
  few: 3, three: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, thirty: 30,
};

/* -------------------------------------------------------------------------- */
/* Civil arithmetic                                                           */
/* -------------------------------------------------------------------------- */

const toUTC = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d);

const fromUTC = (ms: number): Civil => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

export const addDays = (c: Civil, n: number): Civil => fromUTC(toUTC(c) + n * DAY_MS);

/** Day of week, 0 = Sunday. */
export const weekdayOf = (c: Civil): number => new Date(toUTC(c)).getUTCDay();

/**
 * Adds months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Rolling over would
 * quietly move a due date past the month the user was thinking of.
 */
export function addMonths(c: Civil, n: number): Civil {
  const total = c.y * 12 + (c.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) };
}

export const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

export const compare = (a: Civil, b: Civil): number => toUTC(a) - toUTC(b);

export const formatISO = (c: Civil): string =>
  `${String(c.y).padStart(4, "0")}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

/** What day it is where the user is, which is the only "today" that matters. */
export function todayIn(tz: string, now: Date = new Date()): Civil {
  // en-CA gives YYYY-MM-DD, which is the one locale format that needs no
  // interpretation. formatToParts avoids depending on the separator.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export type Resolved = {
  date: Civil;
  /** How the phrase was read, for the confirmation line and for debugging. */
  kind: "explicit" | "relative" | "weekday" | "month_end" | "immediate";
};

const NUM = (w: string | undefined): number | null => {
  if (!w) return null;
  const n = NUMBER_WORDS[w] ?? Number(w);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Reads a due-date phrase. Returns null if it is not a date at all, which is
 * the caller's signal to ask rather than to guess.
 *
 * `today` is passed in rather than read from the clock so that every case in
 * the test table is a fixed, repeatable sum.
 */
export function resolveDueDate(phrase: string, today: Civil): Resolved | null {
  let s = phrase
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(time|from now|from today)$/, "")
    .trim();

  // The words people put in front of a date carry no information, and they
  // stack: "due on receipt" needs two passes, not one.
  const FILLER = /^(due|by|on|before|not later than|latest|pay(?:able)?|deadline|within)\s+/;
  for (let i = 0; i < 3 && FILLER.test(s); i++) s = s.replace(FILLER, "");

  if (!s) return null;

  /* Now, or as good as. --------------------------------------------------- */
  // "receipt" on its own is what "on receipt" becomes once the leading "on"
  // has been stripped as a filler word.
  if (/^(today|asap|now|immediately|receipt|upon receipt|instant(?:ly)?)$/.test(s)) {
    return { date: today, kind: "immediate" };
  }
  if (/^(tonight|end of (?:the )?day|cob|eod)$/.test(s)) return { date: today, kind: "immediate" };
  if (/^tomorrow$/.test(s)) return { date: addDays(today, 1), kind: "relative" };
  if (/^(day after tomorrow|overmorrow)$/.test(s)) return { date: addDays(today, 2), kind: "relative" };

  /* Month and week ends. --------------------------------------------------- */
  let m: RegExpExecArray | null;

  if ((m = /^(?:the )?end of (?:the )?month$|^month ?end$/.exec(s))) {
    return { date: { ...today, d: daysInMonth(today.y, today.m) }, kind: "month_end" };
  }
  if (/^(?:the )?end of (?:the )?(?:next|following) month$/.test(s)) {
    const next = addMonths({ ...today, d: 1 }, 1);
    return { date: { ...next, d: daysInMonth(next.y, next.m) }, kind: "month_end" };
  }
  if (/^(?:the )?end of (?:the )?week$|^week ?end$/.test(s)) {
    // Friday, not Sunday: an invoice due "end of week" is due before the
    // weekend, because nobody is at a desk on Saturday to pay it.
    return { date: nextWeekday(today, 5, false), kind: "weekday" };
  }

  /* "in two weeks", "in 30 days", "in a month". ---------------------------- */
  if ((m = /^(?:in|after) ([a-z0-9]+) (day|days|week|weeks|month|months|year|years)$/.exec(s))) {
    const n = NUM(m[1]);
    // Not a quantity, so this was never a counted offset. Fall through rather
    // than give up: "next week" reaches here before the rule that knows it.
    if (n !== null) {
      const unit = m[2]!;
      if (unit.startsWith("day")) return { date: addDays(today, n), kind: "relative" };
      if (unit.startsWith("week")) return { date: addDays(today, n * 7), kind: "relative" };
      if (unit.startsWith("month")) return { date: addMonths(today, n), kind: "relative" };
      return { date: addMonths(today, n * 12), kind: "relative" };
    }
  }

  /* "30 days", "14 days", "net 30" — the way payment terms are written. ---- */
  if ((m = /^(?:net ?)?([a-z0-9]+) (day|days|week|weeks|month|months)$/.exec(s))) {
    const n = NUM(m[1]);
    if (n !== null) {
      const unit = m[2]!;
      if (unit.startsWith("day")) return { date: addDays(today, n), kind: "relative" };
      if (unit.startsWith("week")) return { date: addDays(today, n * 7), kind: "relative" };
      return { date: addMonths(today, n), kind: "relative" };
    }
  }
  if ((m = /^net ?(\d{1,3})$/.exec(s))) {
    return { date: addDays(today, Number(m[1])), kind: "relative" };
  }

  /* "next week", "next month". --------------------------------------------- */
  if (/^(?:the )?(?:next|following) week$/.test(s)) return { date: addDays(today, 7), kind: "relative" };
  if (/^(?:the )?(?:next|following) month$/.test(s)) return { date: addMonths(today, 1), kind: "relative" };

  /* Weekdays. -------------------------------------------------------------- */
  if ((m = /^(this|next|coming|following)? ?([a-z]+)$/.exec(s))) {
    const day = WEEKDAYS[m[2]!];
    if (day !== undefined) {
      // "next Friday" is the Friday of the week after this one, which is what
      // people mean when they bother to say "next" at all.
      const jumpAWeek = m[1] === "next" || m[1] === "following";
      return { date: nextWeekday(today, day, jumpAWeek), kind: "weekday" };
    }
  }

  /* Explicit dates. --------------------------------------------------------- */
  return explicitDate(s, today);
}

/**
 * The next such weekday strictly after today.
 *
 * Strictly: "due Friday" said on a Friday means the coming Friday, a week out.
 * Somebody who means today has the word "today", and reading it as today would
 * make an invoice overdue the moment it was sent.
 */
function nextWeekday(today: Civil, target: number, jumpAWeek: boolean): Civil {
  const delta = (target - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, delta + (jumpAWeek ? 7 : 0));
}

function explicitDate(s: string, today: Civil): Resolved | null {
  let m: RegExpExecArray | null;

  /* ISO, which is unambiguous and so is tried first. */
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return civil(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /* "25 December", "25th Dec", "December 25", "Dec 25 2026". */
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)\.?(?: (\d{4}))?$/.exec(s))) {
    const month = MONTHS[m[2]!];
    if (month) return rollForward(Number(m[1]), month, m[3] ? Number(m[3]) : null, today);
  }
  if ((m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s))) {
    const month = MONTHS[m[1]!];
    if (month) return rollForward(Number(m[2]), month, m[3] ? Number(m[3]) : null, today);
  }

  /* "the 30th", "30th" — this month, or next if it has already gone. */
  if ((m = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/.exec(s))) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) return null;
    if (d >= today.d && d <= daysInMonth(today.y, today.m)) {
      return civil(today.y, today.m, d);
    }
    const next = addMonths({ ...today, d: 1 }, 1);
    return d <= daysInMonth(next.y, next.m) ? civil(next.y, next.m, d) : null;
  }

  /* "25/12", "25/12/2026", "25-12-26". Day first: that is how it is written
     here, and how every bank form in the country asks for it. */
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    // Day first unless that is impossible, in which case they wrote it the
    // American way and meant the other one.
    const [d, mo] = b <= 12 ? [a, b] : [b, a];
    return rollForward(d, mo, year, today);
  }

  return null;
}

/** A bare "25 Dec" in January means this year; in December it means next. */
function rollForward(d: number, month: number, year: number | null, today: Civil): Resolved | null {
  if (year !== null) return civil(year, month, d);
  const thisYear = civil(today.y, month, d);
  if (!thisYear) return null;
  return compare(thisYear.date, today) < 0 ? civil(today.y + 1, month, d) : thisYear;
}

/** Rejects 31 February rather than letting it become 3 March. */
function civil(y: number, m: number, d: number): Resolved | null {
  if (m < 1 || m > 12 || d < 1 || y < 1970 || y > 9999) return null;
  if (d > daysInMonth(y, m)) return null;
  return { date: { y, m, d }, kind: "explicit" };
}

/* -------------------------------------------------------------------------- */

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// prettier-ignore
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * How a resolved date is written back to the user: "Fri, 25 Dec".
 *
 * Spelled out here rather than left to `toLocaleDateString`, which under
 * current CLDR renders September as "Sept" in en-GB: four characters where
 * every other month gets three. A date printed on an invoice should not vary
 * with the host's ICU build.
 */
export function formatFriendly(c: Civil, today?: Civil): string {
  const year = today && today.y !== c.y ? ` ${c.y}` : "";
  return `${DAY_SHORT[weekdayOf(c)]}, ${c.d} ${MONTH_SHORT[c.m - 1]}${year}`;
}
