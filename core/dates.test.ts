import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  compare,
  daysInMonth,
  formatFriendly,
  formatISO,
  resolveDueDate,
  todayIn,
  weekdayOf,
  type Civil,
} from "./dates.ts";

/** Wednesday, 23 September 2026. Every case below is relative to this. */
const WED: Civil = { y: 2026, m: 9, d: 23 };

const on = (today: Civil, phrase: string) => {
  const r = resolveDueDate(phrase, today);
  return r ? formatISO(r.date) : null;
};

describe("the fixed point", () => {
  it("is a Wednesday, so the weekday cases mean what they say", () => {
    assert.equal(weekdayOf(WED), 3);
  });
});

describe("dates people actually write", () => {
  const cases: [string, string | null][] = [
    // Now, or as good as.
    ["today", "2026-09-23"],
    ["asap", "2026-09-23"],
    ["immediately", "2026-09-23"],
    ["on receipt", "2026-09-23"],
    ["due on receipt", "2026-09-23"],
    ["tonight", "2026-09-23"],
    ["eod", "2026-09-23"],
    ["tomorrow", "2026-09-24"],
    ["day after tomorrow", "2026-09-25"],

    // Weekdays. Wednesday is day 3.
    ["friday", "2026-09-25"],
    ["Friday", "2026-09-25"],
    ["fri", "2026-09-25"],
    ["on Friday", "2026-09-25"],
    ["due Friday", "2026-09-25"],
    ["by friday", "2026-09-25"],
    ["this friday", "2026-09-25"],
    ["coming friday", "2026-09-25"],
    ["next friday", "2026-10-02"],
    ["monday", "2026-09-28"],
    ["mon", "2026-09-28"],
    ["next monday", "2026-10-05"],
    // How a date is said here. "Upper week" is next week, and naming the week
    // before the day is the ordinary word order, not a mistake to tolerate:
    // "due upper week monday" was answered with "I did not catch that".
    //
    // Naming the week is a different question from "next Monday". It fixes
    // which seven days are meant, so said on this Wednesday it is five days
    // out — where "next monday" above, which names no week, is twelve.
    ["upper week monday", "2026-09-28"],
    ["next week monday", "2026-09-28"],
    ["monday next week", "2026-09-28"],
    ["due next week tuesday", "2026-09-29"],
    ["upper week friday", "2026-10-02"],
    ["this week friday", "2026-09-25"],
    ["upper week", "2026-09-30"],
    ["upper monday", "2026-10-05"],
    // The day after tomorrow, to everybody in the country.
    ["next tomorrow", "2026-09-25"],

    ["sunday", "2026-09-27"],
    ["saturday", "2026-09-26"],
    ["tues", "2026-09-29"],
    ["thurs", "2026-09-24"],

    // Counted offsets, in digits and in words.
    ["in 3 days", "2026-09-26"],
    ["in three days", "2026-09-26"],
    ["in a week", "2026-09-30"],
    ["in one week", "2026-09-30"],
    ["in two weeks", "2026-10-07"],
    ["in 2 weeks", "2026-10-07"],
    ["in a couple of weeks", null], // "of" is not handled, and guessing is worse
    ["in 30 days", "2026-10-23"],
    ["in a month", "2026-10-23"],
    ["in two months", "2026-11-23"],
    ["in 6 months", "2027-03-23"],
    ["in a year", "2027-09-23"],
    ["in 3 days time", "2026-09-26"],
    ["in 2 weeks from now", "2026-10-07"],

    // Payment terms, as they appear on an invoice.
    ["7 days", "2026-09-30"],
    ["14 days", "2026-10-07"],
    ["30 days", "2026-10-23"],
    ["net 30", "2026-10-23"],
    ["net30", "2026-10-23"],
    ["net 7", "2026-09-30"],
    ["two weeks", "2026-10-07"],
    ["one month", "2026-10-23"],

    // Weeks and months as blocks.
    ["next week", "2026-09-30"],
    ["next month", "2026-10-23"],
    ["end of month", "2026-09-30"],
    ["month end", "2026-09-30"],
    ["end of the month", "2026-09-30"],
    ["the end of the month", "2026-09-30"],
    ["end of next month", "2026-10-31"],
    ["end of week", "2026-09-25"],
    ["end of the week", "2026-09-25"],

    // Explicit, written the way it is written here.
    ["2026-12-25", "2026-12-25"],
    ["25/12", "2026-12-25"],
    ["25/12/2026", "2026-12-25"],
    ["25-12-2026", "2026-12-25"],
    ["25.12.2026", "2026-12-25"],
    ["25/12/26", "2026-12-25"],
    ["1/10", "2026-10-01"],
    ["25 december", "2026-12-25"],
    ["25th december", "2026-12-25"],
    ["25th of december", "2026-12-25"],
    ["25 dec", "2026-12-25"],
    ["december 25", "2026-12-25"],
    ["dec 25", "2026-12-25"],
    ["dec 25 2027", "2027-12-25"],
    ["25 dec 2027", "2027-12-25"],
    ["the 30th", "2026-09-30"],
    ["30th", "2026-09-30"],

    // Not dates. Guessing here would put a wrong day on a real invoice.
    ["", null],
    ["soon", null],
    ["when you can", null],
    ["later", null],
    ["whenever", null],
    ["logo design", null],
    ["350k", null],
    ["32/13", null],
    ["31 february", null],
    ["2026-02-30", null],
    ["blursday", null],
  ];

  for (const [phrase, expected] of cases) {
    it(`${JSON.stringify(phrase)} -> ${expected ?? "null"}`, () => {
      assert.equal(on(WED, phrase), expected);
    });
  }
});

describe("the awkward corners of the calendar", () => {
  it("a bare day that has passed rolls into next month", () => {
    assert.equal(on({ y: 2026, m: 9, d: 25 }, "the 10th"), "2026-10-10");
  });

  it("a bare day still to come stays in this month", () => {
    assert.equal(on({ y: 2026, m: 9, d: 5 }, "the 10th"), "2026-09-10");
  });

  it("skips a month that is too short for the day", () => {
    // 31 January: the 30th has gone, and February cannot hold a 30th either.
    assert.equal(on({ y: 2026, m: 1, d: 31 }, "the 30th"), null);
    // Whereas the 31st on the 31st is simply today.
    assert.equal(on({ y: 2026, m: 1, d: 31 }, "the 31st"), "2026-01-31");
  });

  it("a month name already gone this year means next year", () => {
    assert.equal(on({ y: 2026, m: 12, d: 26 }, "25 dec"), "2027-12-25");
  });

  it("the same month name still ahead stays this year", () => {
    assert.equal(on({ y: 2026, m: 12, d: 24 }, "25 dec"), "2026-12-25");
  });

  it("end of month is right in February, leap year or not", () => {
    assert.equal(on({ y: 2028, m: 2, d: 3 }, "month end"), "2028-02-29");
    assert.equal(on({ y: 2026, m: 2, d: 3 }, "month end"), "2026-02-28");
  });

  it("end of month on the last day is that day", () => {
    assert.equal(on({ y: 2026, m: 9, d: 30 }, "month end"), "2026-09-30");
  });

  it("a weekday spoken on itself means the week after", () => {
    // Friday, asking for Friday. Reading it as today would make the invoice
    // overdue the moment it was sent.
    assert.equal(on({ y: 2026, m: 9, d: 25 }, "friday"), "2026-10-02");
  });

  it("crosses the year on a weekday", () => {
    assert.equal(on({ y: 2026, m: 12, d: 31 }, "friday"), "2027-01-01");
  });

  it("adding a month clamps instead of rolling over", () => {
    // 31 January plus a month is the end of February, not the 3rd of March.
    assert.deepEqual(addMonths({ y: 2026, m: 1, d: 31 }, 1), { y: 2026, m: 2, d: 28 });
    assert.deepEqual(addMonths({ y: 2028, m: 1, d: 31 }, 1), { y: 2028, m: 2, d: 29 });
    assert.deepEqual(addMonths({ y: 2026, m: 8, d: 31 }, 1), { y: 2026, m: 9, d: 30 });
  });

  it("reads an impossible day-first date the other way round", () => {
    // 13 cannot be a month, so they wrote month first and meant 13 December.
    assert.equal(on(WED, "12/13"), "2026-12-13");
  });

  it("knows how long every month is, including February", () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2028, 2), 29);
    assert.equal(daysInMonth(2026, 9), 30);
    assert.equal(daysInMonth(2026, 12), 31);
  });
});

describe("nothing lands in the past", () => {
  // Except an explicit date with a year in it, which the caller rejects with a
  // message naming the date - a silent roll to next year would be worse.
  const phrases = [
    "today", "tomorrow", "friday", "monday", "next friday", "in 3 days",
    "in two weeks", "net 30", "end of month", "next week", "next month",
    "the 30th", "25 dec", "end of week",
  ];

  for (const start of [
    { y: 2026, m: 1, d: 1 },
    { y: 2026, m: 2, d: 28 },
    { y: 2026, m: 9, d: 30 },
    { y: 2026, m: 12, d: 31 },
    { y: 2028, m: 2, d: 29 },
  ] as Civil[]) {
    it(`from ${formatISO(start)}`, () => {
      for (const phrase of phrases) {
        const r = resolveDueDate(phrase, start);
        assert.ok(r, `${phrase} should resolve`);
        assert.ok(
          compare(r.date, start) >= 0,
          `"${phrase}" from ${formatISO(start)} gave ${formatISO(r.date)}, which is in the past`,
        );
      }
    });
  }
});

describe("today, where the user is", () => {
  it("is Lagos's day, not the server's", () => {
    // 22:30 UTC on the 23rd is 23:30 in Lagos: still the 23rd.
    assert.deepEqual(todayIn("Africa/Lagos", new Date("2026-09-23T22:30:00Z")), WED);
    // 23:30 UTC is 00:30 on the 24th in Lagos, and an invoice dated "today"
    // there must say the 24th.
    assert.deepEqual(todayIn("Africa/Lagos", new Date("2026-09-23T23:30:00Z")), {
      y: 2026, m: 9, d: 24,
    });
  });

  it("does not drift with the machine's own timezone", () => {
    const at = new Date("2026-09-23T12:00:00Z");
    assert.deepEqual(todayIn("Africa/Lagos", at), WED);
    assert.deepEqual(todayIn("UTC", at), WED);
    assert.deepEqual(todayIn("Pacific/Auckland", at), { y: 2026, m: 9, d: 24 });
  });
});

describe("writing the date back", () => {
  it("reads as a person would say it", () => {
    assert.equal(formatFriendly({ y: 2026, m: 9, d: 25 }), "Fri, 25 Sep");
    assert.equal(formatFriendly({ y: 2026, m: 12, d: 25 }), "Fri, 25 Dec");
  });

  it("names the year only when it is not this one", () => {
    assert.equal(formatFriendly({ y: 2026, m: 12, d: 25 }, WED), "Fri, 25 Dec");
    assert.equal(formatFriendly({ y: 2027, m: 1, d: 4 }, WED), "Mon, 4 Jan 2027");
  });
});
