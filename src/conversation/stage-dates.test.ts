/**
 * "50% deposit due on Friday and the balance should be due on Tuesday", sent
 * to a one-payment draft, was read as nothing: "I did not catch that", twice
 * (30 September 2026). One message sets the plan and dates two of its parts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCorrection } from "../parser/corrections.ts";
import { applyCorrection } from "./machine.ts";
import { planLines } from "../documents/summary.ts";
import type { Civil } from "../../core/dates.ts";

const today: Civil = { y: 2026, m: 9, d: 30 }; // a Wednesday
const draft = {
  type: "invoice" as const,
  clientName: "Edidiong Uwak",
  lines: [{ description: "Website design", qty: 1, unitAmountKobo: 800_000_00 }],
  dueDate: { y: 2026, m: 10, d: 1 } as Civil,
  depositPercent: null,
  instalments: null,
} as never;

describe("a deposit and both its dates in one message", () => {
  const c = readCorrection("50% deposit due on friday and the balance should be due on Tuesday", today)!;

  it("reads as the deposit and two dated parts", () => {
    assert.equal(c.depositPercent, 50);
    assert.deepEqual(c.stageDues?.map((s) => [s.which, s.date]), [
      ["first", { y: 2026, m: 10, d: 2 }],
      ["last", { y: 2026, m: 10, d: 6 }],
    ]);
  });

  it("puts each date on its part, and the invoice falls due with the last", () => {
    const next = applyCorrection(draft, c) as unknown as {
      depositPercent: number;
      stageDueDates: Civil[];
      dueDate: Civil;
    };
    assert.equal(next.depositPercent, 50);
    assert.deepEqual(next.stageDueDates, [
      { y: 2026, m: 10, d: 2 },
      { y: 2026, m: 10, d: 6 },
    ]);
    // Not Friday: the deposit's date is not the invoice's.
    assert.deepEqual(next.dueDate, { y: 2026, m: 10, d: 6 });
    const plan = planLines({ ...(next as object), totalKobo: 800_000_00 } as never, today).join("\n");
    assert.match(plan, /50% deposit .*Fri, 2 Oct/);
    assert.match(plan, /Balance .*Tue, 6 Oct/);
  });

  it("still reads one change as one, and nonsense as nothing", () => {
    assert.deepEqual(readCorrection("make it 400k, due next Friday", today), {
      dueDate: { y: 2026, m: 10, d: 9 },
      duePhrase: "next Friday",
      totalKobo: 400_000_00,
    });
    assert.equal(readCorrection("hello and goodbye", today), null);
  });
});
