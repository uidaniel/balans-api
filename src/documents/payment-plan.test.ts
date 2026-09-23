/**
 * Where a payment plan has to appear, and what the figures have to be.
 *
 * Two failures live here, and they are different in kind.
 *
 * The first was arithmetic. A shape carried a percentage and the money was
 * worked out from it later, so a third became 33.33% — three of those is
 * 99.99% of the total, and the last part quietly swallowed the difference.
 * "3 equal payments" of ₦300,000 was billed as ₦99,990, ₦99,990 and ₦100,020.
 * Every test passed, because every test asked whether the parts summed to the
 * total. They did. None asked whether the equal parts were equal.
 *
 * The second was that the plan was chosen, stored correctly, shown on the
 * draft — and then left off the message the user forwards to their client. So
 * the client read "₦300,000, click to pay", opened the link, and was asked for
 * ₦75,000. Setting a value is not the same as showing it, and the gap between
 * those two was one function away.
 *
 * Both are pinned here because both survived a full suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { draftSummary, sentMessage, planLines } from "./summary.ts";
import { shapeFor } from "./parts.ts";
import type { Draft } from "./store.ts";

const N = (naira: number) => naira * 100;
const today = { y: 2026, m: 9, d: 23 };

const draft = (over: Partial<Draft>): Draft =>
  ({
    id: "d1",
    clientId: "c1",
    type: "invoice",
    clientName: "Zenith Homes",
    clientEmail: null,
    lines: [{ description: "Brand identity", qty: 1, unitAmountKobo: N(300_000) }],
    dueDate: { y: 2026, m: 10, d: 3 },
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    subtotalKobo: N(300_000),
    vatKobo: 0,
    totalKobo: N(300_000),
    number: 7,
    publicToken: "tok",
    ...over,
  }) as Draft;

const sent = (d: Draft) =>
  sentMessage(d, { number: 7, publicToken: "tok" }, "https://payment.balans.ng", today).forward;

describe("a payment plan reaches both messages", () => {
  for (const [name, over, expected] of [
    ["a deposit", { depositPercent: 25 }, ["25% deposit — ₦75,000", "Balance — ₦225,000"]],
    [
      "instalments",
      { instalments: 3 },
      ["Part 1 of 3 — ₦100,000", "Part 2 of 3 — ₦100,000", "Part 3 of 3 — ₦100,000"],
    ],
  ] as const) {
    it(`shows ${name} on the draft, before they approve it`, () => {
      const m = draftSummary(draft(over), today);
      for (const line of expected) assert.ok(m.includes(line), `missing "${line}" in:\n${m}`);
    });

    it(`shows ${name} on the message they forward to the client`, () => {
      // The client is the one being asked for a deposit, so the client is the
      // one who has to be told. Without this the forward says "₦300,000, click
      // to pay" and the page it opens asks for ₦75,000.
      const m = sent(draft(over));
      for (const line of expected) assert.ok(m.includes(line), `missing "${line}" in:\n${m}`);
    });
  }

  it("says which stage is due now, on both", () => {
    const d = draft({ depositPercent: 25 });
    // The first part is written `payable` and the rest `pending`, so this is
    // a fact about the data rather than a turn of phrase.
    assert.match(draftSummary(d, today), /25% deposit — ₦75,000 \(due now\)/);
    assert.match(sent(d), /25% deposit — ₦75,000 \(due now\)/);
    assert.equal((sent(d).match(/due now/g) ?? []).length, 1, "only the first stage");
  });

  it("stays quiet when there is no plan", () => {
    // One payment needs no schedule, and printing one would invent a stage.
    assert.deepEqual(planLines(draft({})), []);
    assert.doesNotMatch(sent(draft({})), /Payment plan/);
    assert.doesNotMatch(draftSummary(draft({}), today), /Payment plan/);
  });
});

describe("the figures on the message are the figures in the database", () => {
  it("matches the rows createParts writes, to the kobo", () => {
    // Both read the same `shapeFor`. This is the assertion that says so, and
    // the one that fails if either ever grows its own arithmetic again.
    for (const over of [
      { depositPercent: 25 },
      { depositPercent: 30 },
      { instalments: 3 },
      { instalments: 7 },
    ]) {
      const d = draft(over);
      const stored = shapeFor(over, d.totalKobo)!;
      const message = sent(d);

      let sum = 0;
      for (const part of stored) {
        sum += part.amountKobo;
        const naira = (part.amountKobo / 100).toLocaleString("en-NG");
        assert.ok(
          message.includes(`${part.label} — ₦${naira}`),
          `the client is not told about "${part.label}" (₦${naira})`,
        );
      }
      assert.equal(sum, d.totalKobo, "and the stages have to come to the total");
    }
  });

  it("never asks for more than the invoice in total", () => {
    // The failure that matters: an invoice whose stages exceed it.
    for (const n of [2, 3, 4, 5, 6, 7, 11, 12]) {
      for (const total of [1, 333, N(1_000), N(350_001)]) {
        const parts = shapeFor({ instalments: n }, total)!;
        assert.equal(
          parts.reduce((t, p) => t + p.amountKobo, 0),
          total,
          `${total} kobo into ${n}`,
        );
      }
    }
  });
});
