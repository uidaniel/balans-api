/**
 * When each payment falls due.
 *
 * `payment_parts` had a label, an amount and a status, and no date. So a "50%
 * deposit" invoice told the client ₦25,000 was due now and ₦25,000 was the
 * "Balance" — and nothing on the invoice, the page, the PDF or the message
 * they were forwarded said when the balance was due. The one question a
 * payment plan raises was the one thing the plan did not answer.
 *
 * The rule is: the due date on the invoice is the last payment's date, the
 * first is due on issue, and anything in between is spaced evenly. It invents
 * nothing — both ends are dates the user gave — which is why it is a rule and
 * not a setting. The alternative was monthly, and monthly can contradict the
 * date on the invoice: three monthly payments against a project that ends in
 * three weeks puts the last one two months after the work.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scheduleFor, stagesFor } from "./parts.ts";
import { planLines } from "./summary.ts";
import { formatISO, type Civil } from "../../core/dates.ts";

const N = (naira: number) => naira * 100;
const today: Civil = { y: 2026, m: 9, d: 23 };
const iso = (dates: (Civil | null)[]) => dates.map((d) => (d ? formatISO(d) : null));

describe("spacing the payments", () => {
  it("puts the first on issue and the last on the due date", () => {
    // A deposit, which is the common case and the whole of it: half now, the
    // rest by the date already on the invoice.
    assert.deepEqual(iso(scheduleFor(2, today, { y: 2026, m: 10, d: 23 })), [
      "2026-09-23",
      "2026-10-23",
    ]);
  });

  it("spaces the ones in between evenly", () => {
    // 23 September to 23 December is 91 days, so three gaps of about 30 —
    // which lands on the 23rd of each month without knowing what a month is.
    assert.deepEqual(iso(scheduleFor(4, today, { y: 2026, m: 12, d: 23 })), [
      "2026-09-23",
      "2026-10-23",
      "2026-11-23",
      "2026-12-23",
    ]);
  });

  it("never lands a payment after the date on the invoice", () => {
    /*
     * The reason this is a rule rather than "monthly". A user who says three
     * payments on an invoice due in three weeks has said something specific,
     * and a schedule that runs past their own date is the product arguing
     * with them about terms they agreed with somebody else.
     */
    for (const parts of [2, 3, 4, 6, 12]) {
      for (const due of [
        { y: 2026, m: 9, d: 25 },
        { y: 2026, m: 10, d: 3 },
        { y: 2027, m: 3, d: 1 },
      ]) {
        const when = scheduleFor(parts, today, due);
        assert.equal(when.length, parts);
        assert.deepEqual(when[0], today, "the first is due on issue");
        assert.deepEqual(when[parts - 1], due, "the last is due on the date given");

        for (let i = 1; i < parts; i++) {
          const before = when[i - 1]!;
          const after = when[i]!;
          assert.ok(
            formatISO(before) <= formatISO(after),
            `${parts} parts to ${formatISO(due)}: part ${i + 1} falls before part ${i}`,
          );
        }
      }
    }
  });

  it("says nothing at all when the invoice has no date", () => {
    // A quote's date lives in valid_until and means something else, and an
    // invoice can be sent without one. A made-up date is worse than none.
    assert.deepEqual(scheduleFor(3, today, null), [null, null, null]);
  });

  it("does not refuse an invoice due before it was issued", () => {
    // Somebody's odd invoice, not a bug. The middle parts collapse onto the
    // issue date and the last still lands where it was put.
    const when = scheduleFor(3, today, { y: 2026, m: 9, d: 1 });
    assert.deepEqual(iso(when), ["2026-09-23", "2026-09-23", "2026-09-01"]);
  });
});

describe("the plan a draft is built with", () => {
  const draft = (over: object) => ({
    totalKobo: N(50_000),
    depositPercent: null,
    instalments: null,
    dueDate: { y: 2026, m: 9, d: 25 } as Civil | null,
    ...over,
  });

  it("carries a date on every stage", () => {
    const stages = stagesFor(draft({ depositPercent: 50 }), N(50_000), today)!;

    assert.deepEqual(
      stages.map((s) => [s.label, s.amountKobo, s.dueOn && formatISO(s.dueOn)]),
      [
        ["50% deposit", N(25_000), "2026-09-23"],
        ["Balance", N(25_000), "2026-09-25"],
      ],
    );
  });

  it("still has no stages at all for one payment", () => {
    // One payment needs no schedule, and printing one would invent a stage.
    assert.equal(stagesFor(draft({}), N(50_000), today), null);
  });

  it("leaves the money exactly where shapeFor put it", () => {
    /*
     * Dates were added beside the arithmetic, not into it. The parts still
     * have to sum to the total to the kobo — that is the failure this whole
     * area already has a test for, and adding a calendar must not reopen it.
     */
    for (const over of [{ depositPercent: 25 }, { instalments: 3 }, { instalments: 6 }]) {
      const stages = stagesFor(draft(over), N(310_000), today)!;
      const sum = stages.reduce((t, s) => t + s.amountKobo, 0);
      assert.equal(sum, N(310_000), `${JSON.stringify(over)} does not add up`);
    }
  });
});

describe("what the user reads before they send it", () => {
  it("says when the balance is due, not just that it exists", () => {
    /*
     * The line this whole change exists for. It used to read
     * "· Balance — ₦25,000" and stop there.
     */
    const lines = planLines(
      {
        totalKobo: N(50_000),
        depositPercent: 50,
        instalments: null,
        dueDate: { y: 2026, m: 9, d: 25 },
      },
      today,
    );

    assert.deepEqual(lines, [
      "Payment plan:",
      "  · 50% deposit — ₦25,000 (due now)",
      "  · Balance — ₦25,000 (due Fri, 25 Sep)",
    ]);
  });

  it("dates every instalment after the first", () => {
    const lines = planLines(
      {
        totalKobo: N(300_000),
        depositPercent: null,
        instalments: 3,
        dueDate: { y: 2026, m: 11, d: 23 },
      },
      today,
    );

    assert.equal((lines.join("\n").match(/due /g) ?? []).length, 3, "every stage says when");
    assert.match(lines[1]!, /due now/, "and only the first says now");
    assert.doesNotMatch(lines[2]!, /due now/);
  });

  it("says nothing about dates it was not given", () => {
    // An invoice with no due date still shows the money, and claims nothing
    // about timing beyond the first part being payable.
    const lines = planLines(
      { totalKobo: N(50_000), depositPercent: 50, instalments: null, dueDate: null },
      today,
    );

    assert.deepEqual(lines, [
      "Payment plan:",
      "  · 50% deposit — ₦25,000 (due now)",
      "  · Balance — ₦25,000",
    ]);
  });
});
