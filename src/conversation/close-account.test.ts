/**
 * Closing an account, and the two ways a tap broke it.
 *
 * Somebody tapped "Close my account" and the bot answered "Your business is
 * now Delete My Account." No confirmation, no warning, and a renamed business
 * printing on their invoices.
 *
 * A tapped list row arrives as ordinary text — WhatsApp sends the row's id —
 * so the machine could not tell it from typing. The conversation happened to
 * be waiting for a new business name, and the row id was the phrase "delete
 * my account", so the rename step took it as the name.
 *
 * The same id was also the phrase that CONFIRMS a deletion. Tap the row, get
 * "send exactly: delete my account", scroll up and tap the same row again —
 * and it sends exactly that. The typing requirement was defeated by the thing
 * it exists to protect against, one tap from irreversible.
 *
 * Both are fixed at different levels on purpose. The id no longer collides,
 * and a tap is refused at the confirmation whatever it says: lists sent
 * before the change are still in people's chats, and their rows are still
 * tappable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step, type Context, type State } from "./machine.ts";
import { SETTINGS_ROW_IDS, settingsList } from "../settings/messages.ts";

const today = { y: 2026, m: 9, d: 23 };
const at = (state: State, text: string, tapped: boolean, ctx: Context = {}) =>
  step(state, ctx, { text, today, tapped }, "1.0");

const effects = (s: ReturnType<typeof at>) => s.effects.map((e) => e.type);

describe("the row that closes an account", () => {
  const rows = settingsList({
    businessName: "Kemi Studio",
    account: null,
    pending: null,
    dueDays: 7,
    designName: null,
    invoiceStart: 1,
  }).sections.flatMap((s) => s.rows);

  it("does not send the phrase that confirms a deletion", () => {
    // The whole bug in one assertion.
    for (const row of rows) {
      assert.notEqual(
        row.id,
        "delete my account",
        `"${row.title}" sends the confirmation phrase when tapped`,
      );
    }
  });

  it("is listed among the ids the machine recognises as taps", () => {
    for (const row of rows) {
      assert.ok(
        (SETTINGS_ROW_IDS as readonly string[]).includes(row.id),
        `"${row.id}" is a row nothing routes`,
      );
    }
  });
});

describe("tapping a row while a question is open", () => {
  it("opens the closure warning instead of becoming a business name", () => {
    // Exactly what happened: mid-rename, tapped Close my account.
    const out = at("settings:business_name", "close my account", true);

    assert.equal(out.next, "settings:delete_confirm");
    assert.deepEqual(effects(out), [], "nothing is saved and nothing is deleted");
    assert.match(out.replies[0]!, /closes your Balans account/i);
  });

  it("does the same from every other step that waits for words", () => {
    for (const state of [
      "onboarding:business_name",
      "settings:due_days",
      "settings:invoice_number",
      "awaiting_field:client_name",
    ] as State[]) {
      const out = at(state, "close my account", true);
      assert.equal(out.next, "settings:delete_confirm", `${state} swallowed the tap`);
    }
  });

  it("still lets somebody be called something a row is named after", () => {
    // Typing is not tapping. A business may be called almost anything, and
    // "change bank" or "invoice design" as prose is still prose.
    const out = at("settings:business_name", "Change Bank Media", false);
    assert.deepEqual(effects(out), ["set_business_name"]);
  });
});

describe("confirming the deletion", () => {
  it("accepts the phrase when it is typed", () => {
    assert.deepEqual(effects(at("settings:delete_confirm", "delete my account", false)), [
      "delete_account",
    ]);
  });

  it("refuses it when it is tapped, however it got there", () => {
    /*
     * Lists sent before the id changed are still in people's chats and their
     * rows are still tappable, so this has to hold for the old id too.
     * Asking somebody to type four words is the entire protection; a tap is
     * not typing.
     */
    for (const text of ["delete my account", "close my account"]) {
      const out = at("settings:delete_confirm", text, true);
      assert.deepEqual(effects(out), [], `a tapped "${text}" deleted the account`);
      assert.equal(out.next, "settings:delete_confirm", "and it keeps asking");
    }
  });

  it("still lets somebody back out", () => {
    for (const no of ["no", "cancel", "never mind"]) {
      const out = at("settings:delete_confirm", no, false);
      assert.equal(out.next, "idle");
      assert.deepEqual(effects(out), []);
      assert.match(out.replies[0]!, /untouched/i);
    }
  });

  it("says what closing costs before asking", () => {
    const warning = at("settings:menu", "close my account", true).replies[0]!;
    assert.match(warning, /invoices are cancelled/i);
    assert.match(warning, /payout account is disconnected/i);
    assert.match(warning, /delete my account/, "and names the words to type");
  });
});
