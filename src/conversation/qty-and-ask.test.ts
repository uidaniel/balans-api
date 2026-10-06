/**
 * Two things a draft could not be told (6 October 2026):
 *
 *   "increase the quantity to 3"  → "I did not catch that"
 *   "add his email"               → "I did not catch that"
 *
 * The first now changes the quantity; the second asks for the address and
 * takes it from the next message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { step, type Context } from "./machine.ts";
import { readCorrection, qtyIn, askForIn } from "../parser/corrections.ts";
import type { Parsed } from "../parser/schema.ts";

const NOW = { y: 2026, m: 10, d: 6 };
const V = "2026-09-draft-1";

const parsed = (): Parsed =>
  ({
    intent: "correct_draft",
    correction: null,
    clientName: null,
    clientEmail: null,
    lineItems: [],
    totalKobo: null,
    dueDate: null,
    dueDatePhrase: null,
    documentNumber: null,
    options: { depositPercent: null, instalments: null, passFeesToClient: null, vatPercent: null, notes: null },
    confidence: 0.9,
    money: { kind: "naira" },
    source: "pattern",
    missing: [],
  }) as unknown as Parsed;

const draft = (lines: { description: string; qty: number; unitAmountKobo: number }[]): Context =>
  ({
    draftId: "00000000-0000-0000-0000-000000000001",
    doc: { type: "invoice", clientName: "Edidiong Uwak", lines, dueDate: { y: 2026, m: 10, d: 6 } },
  }) as Context;

const say = (ctx: Context, text: string) =>
  step("awaiting_confirm", ctx, { text, today: NOW, parsed: parsed(), correction: readCorrection(text, NOW) }, V);

const one = draft([{ description: "Balans Website Design", qty: 1, unitAmountKobo: 500_000_00 }]);
const two = draft([
  { description: "Logo design", qty: 1, unitAmountKobo: 50_000_00 },
  { description: "Flyer", qty: 2, unitAmountKobo: 10_000_00 },
]);

describe("changing a quantity", () => {
  for (const text of ["increase the quantity to 3", "change qty to 3", "quantity 3", "make it 3 units", "set the quantity as 3"]) {
    it(`"${text}" on a one-item draft`, () => {
      const out = say(one, text);
      assert.equal(out.context.doc?.lines[0]?.qty, 3, out.replies.join(" | "));
      assert.equal(out.context.doc?.lines[0]?.unitAmountKobo, 500_000_00, "the price of one changed");
    });
  }

  it("names the item on a draft with several", () => {
    const out = say(two, "change the quantity of the flyer to 5");
    assert.equal(out.context.doc?.lines[1]?.qty, 5);
    assert.equal(out.context.doc?.lines[0]?.qty, 1);
  });

  it("asks which, when several and none named", () => {
    const out = say(two, "increase the quantity to 3");
    assert.match(out.replies.join(" "), /Which item should be × 3/);
    assert.deepEqual(out.context.doc?.lines, two.doc!.lines);
  });

  it("never reads money as a quantity", () => {
    assert.equal(qtyIn("change the quantity to 3k"), null);
    assert.equal(qtyIn("make it 400k"), null);
    assert.equal(qtyIn("due friday"), null);
  });
});

describe("adding the client's email without it", () => {
  it("asks for it, by name", () => {
    const out = say(one, "add his email");
    assert.match(out.replies.join(" "), /What is \*Edidiong Uwak\*'s email/);
    assert.equal(out.next, "awaiting_confirm");
  });

  it("takes it from the next message", () => {
    const out = say(one, "edidiong@example.com");
    assert.equal((out.context.doc as { clientEmail?: string }).clientEmail, "edidiong@example.com");
  });

  it("does not ask when the address is there", () => {
    assert.equal(askForIn("add his email edidiong@example.com"), null);
    assert.equal(askForIn("add his number 08031234567"), null);
    assert.equal(askForIn("add her whatsapp number"), "phone");
  });
});
