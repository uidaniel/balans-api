import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatISO, weekdayOf, type Civil } from "./dates.ts";
import { defaultPeriod, readPeriod } from "./period.ts";

/** Wednesday, 23 September 2026, matching the other date suites. */
const WED: Civil = { y: 2026, m: 9, d: 23 };

const range = (text: string, today: Civil = WED) => {
  const p = readPeriod(text, today);
  return p ? `${formatISO(p.from)}..${formatISO(p.to)}` : null;
};
const label = (text: string, today: Civil = WED) => readPeriod(text, today)?.label ?? null;

describe("periods people ask for", () => {
  const cases: [string, string | null][] = [
    ["this month", "2026-09-01..2026-09-30"],
    ["how did i do this month", "2026-09-01..2026-09-30"],
    ["last month", "2026-08-01..2026-08-31"],
    ["previous month", "2026-08-01..2026-08-31"],
    // Wednesday the 23rd: the working week began Monday the 21st.
    ["this week", "2026-09-21..2026-09-27"],
    ["last week", "2026-09-14..2026-09-20"],
    ["today", "2026-09-23..2026-09-23"],
    ["yesterday", "2026-09-22..2026-09-22"],
    ["this year", "2026-01-01..2026-12-31"],
    ["last year", "2025-01-01..2025-12-31"],
    ["last 30 days", "2026-08-25..2026-09-23"],
    ["past 7 days", "2026-09-17..2026-09-23"],
    // A month already gone this year.
    ["march", "2026-03-01..2026-03-31"],
    ["how about august", "2026-08-01..2026-08-31"],
    // A month still to come means the one that has been.
    ["december", "2025-12-01..2025-12-31"],
    ["all time", "2020-01-01..2026-09-23"],
    ["overall", "2020-01-01..2026-09-23"],
    // Not a period.
    ["", null],
    ["who owes me", null],
    ["invoice Tunde 20k", null],
  ];

  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} -> ${expected ?? "null"}`, () => {
      assert.equal(range(text), expected);
    });
  }
});

describe("the week runs Monday to Sunday", () => {
  // A working week, not a calendar one. A Monday summary that already counts
  // yesterday reads as broken.
  it("starts on Monday whatever day it is asked", () => {
    for (let i = 0; i < 7; i++) {
      const today = { y: 2026, m: 9, d: 21 + i };
      const p = readPeriod("this week", today);
      assert.ok(p);
      assert.equal(formatISO(p.from), "2026-09-21", `from ${formatISO(today)}`);
      assert.equal(weekdayOf(p.from), 1, "must begin on a Monday");
    }
  });

  it("gives Monday its own week, not the one just gone", () => {
    const monday: Civil = { y: 2026, m: 9, d: 21 };
    assert.equal(range("this week", monday), "2026-09-21..2026-09-27");
  });

  it("keeps Sunday in the week it belongs to", () => {
    const sunday: Civil = { y: 2026, m: 9, d: 27 };
    assert.equal(weekdayOf(sunday), 0);
    assert.equal(range("this week", sunday), "2026-09-21..2026-09-27");
  });
});

describe("months of different lengths", () => {
  it("ends February on the right day", () => {
    assert.equal(range("this month", { y: 2026, m: 2, d: 10 }), "2026-02-01..2026-02-28");
    assert.equal(range("this month", { y: 2028, m: 2, d: 10 }), "2028-02-01..2028-02-29");
  });

  it("crosses the year backwards for last month in January", () => {
    assert.equal(range("last month", { y: 2026, m: 1, d: 15 }), "2025-12-01..2025-12-31");
  });

  it("ends a 31-day month on the 31st", () => {
    assert.equal(range("this month", { y: 2026, m: 1, d: 5 }), "2026-01-01..2026-01-31");
  });
});

describe("what it is called back to the user", () => {
  it("uses their words where it can", () => {
    assert.equal(label("this month"), "this month");
    assert.equal(label("last week"), "last week");
    assert.equal(label("last 30 days"), "the last 30 days");
  });

  it("names a month, and the year only when it is not this one", () => {
    assert.equal(label("march"), "March");
    assert.equal(label("december"), "December 2025");
  });

  it("defaults to the month when nothing is named", () => {
    const p = defaultPeriod(WED);
    assert.equal(p.label, "this month");
    assert.equal(formatISO(p.from), "2026-09-01");
    assert.equal(formatISO(p.to), "2026-09-30");
  });
});

describe("a range never runs backwards", () => {
  it("holds for every phrase, from any day of the year", () => {
    const phrases = [
      "this month", "last month", "this week", "last week", "today", "yesterday",
      "this year", "last year", "last 30 days", "march", "december", "all time",
    ];
    for (let m = 1; m <= 12; m++) {
      const today: Civil = { y: 2026, m, d: 15 };
      for (const phrase of phrases) {
        const p = readPeriod(phrase, today);
        assert.ok(p, `${phrase} should resolve`);
        assert.ok(
          formatISO(p.from) <= formatISO(p.to),
          `"${phrase}" in month ${m} gave ${formatISO(p.from)}..${formatISO(p.to)}`,
        );
      }
    }
  });
});
