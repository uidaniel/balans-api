/**
 * The ways people actually ask to change a draft (30 September 2026).
 *
 * Found by trying fifty-odd phrasings against a real draft: seventeen read as
 * nothing and eight read as a change that did nothing — the bot redrew the
 * same draft as if it had worked. These are the ones that now must work.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCorrection, stageDatesIn } from "../parser/corrections.ts";
import { applyCorrection } from "./machine.ts";
import type { Civil } from "../../core/dates.ts";

const today: Civil = { y: 2026, m: 9, d: 30 }; // Wednesday
const iso = (c: Civil | null | undefined) =>
  c ? `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}` : null;

type Out = { deposit: number | null; parts: number | null; dates: (string | null)[]; due: string | null; vat?: number | null; amount?: number };
const base = (plan: { depositPercent?: number | null; instalments?: number | null } = {}) =>
  ({
    type: "invoice",
    clientName: "Edidiong Uwak",
    lines: [{ description: "Website design", qty: 1, unitAmountKobo: 800_000_00 }],
    dueDate: { y: 2026, m: 10, d: 1 },
    depositPercent: plan.depositPercent ?? null,
    instalments: plan.instalments ?? null,
  }) as never;

function after(text: string, plan?: Parameters<typeof base>[0]): Out {
  const c = readCorrection(text, today);
  assert.ok(c, `"${text}" was not understood`);
  const n = applyCorrection(base(plan), c) as unknown as {
    depositPercent: number | null;
    instalments: number | null;
    stageDueDates?: (Civil | null)[];
    dueDate: Civil;
    vatPercent?: number | null;
    lines: { unitAmountKobo: number }[];
  };
  return {
    deposit: n.depositPercent ?? null,
    parts: n.instalments ?? null,
    dates: (n.stageDueDates ?? []).map((d) => iso(d)),
    due: iso(n.dueDate),
    vat: n.vatPercent ?? null,
    amount: n.lines[0]!.unitAmountKobo / 100,
  };
}

describe("changing a one-payment draft", () => {
  const cases: [string, Partial<Out>][] = [
    ["50% deposit due on friday and the balance should be due on Tuesday", { deposit: 50, dates: ["2026-10-02", "2026-10-06"], due: "2026-10-06" }],
    ["deposit of 40% due friday, rest due next week", { deposit: 40, dates: ["2026-10-02", "2026-10-07"], due: "2026-10-07" }],
    ["50% deposit due friday & balance due tuesday", { deposit: 50, dates: ["2026-10-02", "2026-10-06"] }],
    ["50% deposit due friday. balance due tuesday", { deposit: 50, dates: ["2026-10-02", "2026-10-06"] }],
    ["deposit: 50% due friday; balance tuesday", { deposit: 50, dates: ["2026-10-02", "2026-10-06"] }],
    ["first half due friday, second half due tuesday", { deposit: 50, dates: ["2026-10-02", "2026-10-06"] }],
    ["half now, half next friday", { deposit: 50, due: "2026-10-09" }],
    ["half upfront, balance on delivery", { deposit: 50, due: "2026-10-01" }],
    ["40 percent deposit", { deposit: 40 }],
    ["50/50", { deposit: 50 }],
    ["deposit na 50%", { deposit: 50 }],
    ["make the deposit 25%", { deposit: 25 }],
    ["change the deposit to 30%", { deposit: 30 }],
    ["balance due 15th october", { due: "2026-10-15" }],
    ["change due date to friday", { due: "2026-10-02" }],
    ["move the date to the 20th", { due: "2026-10-20" }],
    ["abeg make am due friday", { due: "2026-10-02" }],
    ["make am 400k", { amount: 400_000 }],
    ["change am to 500k", { amount: 500_000 }],
    ["add 7.5% vat", { vat: 7.5 }],
  ];
  for (const [text, want] of cases) {
    it(text, () => {
      const got = after(text);
      for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k as keyof Out], v, `${text}: ${k}`);
    });
  }
});

describe("changing a draft that already has a plan", () => {
  it("dates the parts it has", () => {
    assert.deepEqual(after("deposit tomorrow, balance next friday", { depositPercent: 50 }).dates, ["2026-10-01", "2026-10-09"]);
    assert.deepEqual(after("second payment due friday", { depositPercent: 50 }).due, "2026-10-02");
    assert.deepEqual(after("milestone 1 due friday, milestone 2 due next friday", { instalments: 3 }).dates, ["2026-10-02", "2026-10-09"]);
    assert.deepEqual(after("third payment due 20th october", { instalments: 3 }).due, "2026-10-20");
  });
});

describe("a new invoice that says its plan", () => {
  it("keeps the deposit's date apart from the invoice's", () => {
    const got = stageDatesIn("invoice Tunde 800k for website design, 50% deposit due friday and balance due tuesday", today);
    assert.equal(got.depositPercent, 50);
    assert.deepEqual(got.stages.map((s) => [s.which, iso(s.date)]), [["first", "2026-10-02"], ["last", "2026-10-06"]]);
  });

  it("finds nothing in an invoice with no plan", () => {
    assert.deepEqual(stageDatesIn("invoice Tunde 800k for website design due friday", today), { stages: [] });
  });
});
