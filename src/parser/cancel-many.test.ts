/**
 * Cancelling several invoices in one message (14 October 2026).
 *
 * People clearing out old invoices typed "cancel invoice 1 3 6 7 8", or
 * pasted "cancel invoice 4" on six lines, and at most the first was acted on.
 * Now a list is read here, for free, and asked back once before anything is
 * cancelled. One number is still the single cancel it always was.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asCommand, MAX_CANCEL } from "./commands.ts";
import { parseMessage } from "./parse.ts";
import type { Parsed } from "./schema.ts";
import { VOICE, step } from "../conversation/machine.ts";
import { cancelManyAsk, cancelledManyMessage } from "../documents/reports.ts";

const today = { y: 2026, m: 10, d: 14 };

describe("a list of invoices to cancel", () => {
  const lists: [string, number[]][] = [
    ["cancel invoices 1, 3, 4", [1, 3, 4]],
    ["cancel invoice 1 3 6 7 8", [1, 3, 6, 7, 8]],
    ["cancel 1,3,4", [1, 3, 4]],
    ["cancel invoices 1 and 3", [1, 3]],
    ["cancel invoices 1, 3 and 4", [1, 3, 4]],
    ["Cancel invoices #2, #5.", [2, 5]],
    ["cancel inv 7 & 9", [7, 9]],
    // The id the assistant puts on a button.
    ["cancel invoices 1 3 4", [1, 3, 4]],
  ];
  for (const [text, numbers] of lists) {
    it(JSON.stringify(text), () => {
      assert.deepEqual(asCommand(text), { intent: "cancel_documents", documentNumbers: numbers });
    });
  }

  it("reads every line of a pasted message", () => {
    const text = "Cancel invoice 3\ncancel invoice 4\n\ncancel invoice #6.\n";
    assert.deepEqual(asCommand(text), { intent: "cancel_documents", documentNumbers: [3, 4, 6] });
  });

  it("drops repeats and keeps the order they were typed in", () => {
    assert.deepEqual(asCommand("cancel invoices 8, 2, 8, 5, 2")?.documentNumbers, [8, 2, 5]);
  });

  it(`stops at ${MAX_CANCEL}`, () => {
    const all = Array.from({ length: 30 }, (_, k) => k + 1);
    const out = asCommand(`cancel invoices ${all.join(", ")}`);
    assert.equal(out?.intent, "cancel_documents");
    assert.deepEqual(out?.documentNumbers, all.slice(0, MAX_CANCEL));
  });

  it("is not a list unless every line is a cancel", () => {
    assert.equal(asCommand("cancel invoice 3\ninvoice Tunde 20k for logo"), null);
    assert.equal(asCommand("cancel invoices 1, 3 and the one for Tunde"), null);
  });
});

describe("one number is the single cancel, as before", () => {
  it("cancel invoice 4", () => {
    assert.deepEqual(asCommand("cancel invoice 4"), { intent: "cancel_document", documentNumber: 4 });
  });
  it("the same line pasted twice", () => {
    assert.deepEqual(asCommand("cancel invoice 4\ncancel invoice 4"), { intent: "cancel_document", documentNumber: 4 });
  });
  it("a bare cancel is still a no", () => {
    assert.equal(asCommand("cancel")?.intent, "reject");
  });
});

describe("the answers to the question", () => {
  it("reads the yes button, with one number or several", () => {
    assert.deepEqual(asCommand("yes cancel invoices 3 4 6"), {
      intent: "confirm_cancel_documents",
      documentNumbers: [3, 4, 6],
    });
    assert.deepEqual(asCommand("yes cancel invoices 3"), { intent: "confirm_cancel_documents", documentNumbers: [3] });
    assert.deepEqual(asCommand("Yes, cancel invoices 3, 4 and 6"), {
      intent: "confirm_cancel_documents",
      documentNumbers: [3, 4, 6],
    });
  });

  it("reads the keep button", () => {
    assert.deepEqual(asCommand("keep invoices"), { intent: "keep_documents" });
    assert.deepEqual(asCommand("Keep the invoices."), { intent: "keep_documents" });
  });
});

describe("never reaches the model", () => {
  // No key and a fetch that throws: anything that tried would fail loudly.
  const fetchImpl = (() => {
    throw new Error("the model was called");
  }) as unknown as typeof fetch;

  for (const text of ["cancel invoices 1, 3, 4", "cancel invoice 3\ncancel invoice 4", "yes cancel invoices 3 4", "keep invoices"]) {
    it(JSON.stringify(text), async () => {
      const out = await parseMessage(text, { today, fetchImpl });
      assert.ok(out.ok);
      assert.equal(out.parsed.source, "command");
    });
  }

  it("carries the numbers through the parse", async () => {
    const out = await parseMessage("cancel invoices 1, 3, 4", { today, fetchImpl });
    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "cancel_documents");
    assert.deepEqual(out.parsed.documentNumbers, [1, 3, 4]);
  });
});

describe("the machine", () => {
  async function at(state: Parameters<typeof step>[0], text: string, ctx = {}) {
    const out = await parseMessage(text, { today });
    assert.ok(out.ok);
    return step(state, ctx, { text, today, parsed: out.parsed }, "1.0");
  }

  it("asks, rather than cancels, at idle", async () => {
    const out = await at("idle", "cancel invoices 1, 3, 4");
    assert.equal(out.next, "idle");
    assert.deepEqual(out.effects, [{ type: "document_action", intent: "cancel_documents", number: null, numbers: [1, 3, 4] }]);
  });

  it("cancels on the yes", async () => {
    const out = await at("idle", "yes cancel invoices 3 4");
    assert.deepEqual(out.effects, [
      { type: "document_action", intent: "confirm_cancel_documents", number: null, numbers: [3, 4] },
    ]);
  });

  it("does nothing on keep, and says so", async () => {
    const out = await at("idle", "keep invoices");
    assert.deepEqual(out.effects, []);
    assert.deepEqual(out.replies, [VOICE.keptDocuments]);
  });

  it("wins over a pending question, like the single cancel", () => {
    const parsed: Parsed = {
      intent: "cancel_documents",
      documentNumbers: [3, 4],
      correction: null,
      clientName: null,
      clientEmail: null,
      lineItems: [],
      totalKobo: null,
      dueDate: null,
      dueDatePhrase: null,
      documentNumber: null,
      options: { depositPercent: null, instalments: null, passFeesToClient: null, vatPercent: null, notes: null },
      confidence: 1,
      money: { kind: "naira" },
      source: "command",
      missing: [],
    };
    const out = step(
      "awaiting_field:amount",
      { doc: { type: "invoice", clientName: "Tunde", lines: [] } },
      { text: "cancel invoices 3 4", today, parsed },
      "1.0",
    );
    assert.equal(out.next, "idle");
    assert.equal(out.effects[0]?.type, "discard_draft");
    assert.deepEqual(out.effects[1], { type: "document_action", intent: "cancel_documents", number: null, numbers: [3, 4] });
  });
});

describe("what it says", () => {
  const preview = [
    { number: 3, ok: true as const, type: "invoice", clientName: "Edidiong Uwak", totalKobo: 972_589_00, currency: "NGN", amountMinor: null },
    { number: 4, ok: true as const, type: "invoice", clientName: "Zenith Homes", totalKobo: 50_000_00, currency: "NGN", amountMinor: null },
    { number: 5, ok: false as const, why: "has_payment" },
    { number: 9, ok: false as const, why: "not_found" },
  ];

  it("lists what can go, what cannot, and puts only the first on the button", () => {
    const ask = cancelManyAsk(preview);
    assert.match(ask.body, /^⚠️ \*Cancel 2 invoices\?\*/);
    assert.match(ask.body, /\*#3\* Edidiong Uwak — ₦972,589/);
    assert.match(ask.body, /Can't cancel:\n- #5 — paid\n- #9 — not found/);
    assert.match(ask.body, /can't be undone/);
    assert.deepEqual(ask.buttons, [
      { id: "yes cancel invoices 3 4", title: "Yes, cancel 2" },
      { id: "keep invoices", title: "Keep them" },
    ]);
    // The id it puts on the button is one this file reads.
    assert.equal(asCommand(ask.buttons[0]!.id)?.intent, "confirm_cancel_documents");
    assert.equal(asCommand(ask.buttons[1]!.id)?.intent, "keep_documents");
  });

  it("keeps button titles inside Meta's twenty characters", () => {
    const many = Array.from({ length: MAX_CANCEL }, (_, k) => ({ ...preview[0]!, number: k + 100 }));
    for (const btn of cancelManyAsk(many).buttons) assert.ok(btn.title.length <= 20, btn.title);
  });

  it("has no buttons when nothing can be cancelled", () => {
    const ask = cancelManyAsk(preview.slice(2));
    assert.deepEqual(ask.buttons, []);
    assert.equal(ask.yesId, null);
    assert.match(ask.body, /#5 — paid/);
  });

  it("answers once, with anything that failed at the last moment", () => {
    const out = cancelledManyMessage([3, 4], [{ number: 6, why: "has_payment" }]);
    assert.match(out, /^🚫 \*Cancelled 2 invoices:\* #3, #4/);
    assert.match(out, /Could not cancel:\n- #6 — paid/);
  });
});
