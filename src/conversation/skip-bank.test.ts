/**
 * The bank account can wait (31 October 2026): skipped at setup, asked for
 * when the first invoice goes, and added any time with "add bank".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step, VOICE, type Context } from "./machine.ts";

const go = (state: Parameters<typeof step>[0], text: string, ctx: Context = {}) =>
  step(state, ctx, { text, today: { y: 2026, m: 10, d: 31 } }, "5.0");

describe("skipping the bank at setup", () => {
  it("says it can be skipped, and why it matters", () => {
    assert.match(VOICE.gotNameAskBank("Kemi Studio"), /reply \*skip\* to add it later\. Your client needs it to pay you/);
  });

  for (const word of ["skip", "Skip for now", "later", "not now"]) {
    it(`goes to the terms on ${JSON.stringify(word)}`, () => {
      const out = go("onboarding:bank", word, { businessName: "Kemi Studio" });
      assert.equal(out.next, "onboarding:consent");
      assert.deepEqual(out.effects.map((e) => e.type), ["ask_consent"]);
    });
  }

  it("still reads an account number as one", () => {
    assert.equal(go("onboarding:bank", "GTBank 0123456789").next, "onboarding:confirm_account");
  });
});

describe("sending with no bank account", () => {
  const draft = {
    draftId: "d1",
    doc: { type: "invoice", clientName: "Zenith", lines: [{ description: "Logo", quantity: 1, unitKobo: 50_000_00 }] },
  } as unknown as Context;

  it("sends without it when told to", () => {
    const out = go("awaiting_confirm", "send without bank", draft);
    assert.deepEqual(out.effects, [{ type: "send_document", withoutBank: true }]);
  });

  it("adds it first when asked, keeping the draft", () => {
    const out = go("awaiting_confirm", "add bank account", draft);
    assert.equal(out.next, "adding_bank");
    assert.equal(out.context.draftId, "d1");
  });
});

describe("adding a bank account after setup", () => {
  it("starts from \"add bank\"", () => {
    const out = go("idle", "add bank");
    assert.deepEqual(out.effects, [{ type: "send_bank_change_code" }]);
  });

  it("checks the account with the bank, and holds here if the bank says no", () => {
    const out = go("adding_bank", "GTBank 0123456789");
    assert.equal(out.next, "adding_bank:confirm");
    const lookup = out.effects[0];
    assert.equal(lookup?.type === "resolve_account" && lookup.holdAt, "adding_bank");
  });

  it("goes back to the waiting draft once confirmed, never to the terms", () => {
    const out = go("adding_bank:confirm", "yes", { draftId: "d1" });
    assert.equal(out.next, "awaiting_confirm");
    assert.deepEqual(out.effects.map((e) => e.type), ["create_subaccount"]);
    assert.match(out.replies.join(" "), /Reply \*yes\* to send it/);
  });

  it("goes idle when there is no draft", () => {
    assert.equal(go("adding_bank:confirm", "yes").next, "idle");
  });

  it("can be left for later", () => {
    assert.equal(go("adding_bank", "later").next, "idle");
  });
});
