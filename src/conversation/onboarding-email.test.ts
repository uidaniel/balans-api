/**
 * Confirming the account, now that setup asks for no email (31 October 2026).
 *
 * The email and its code came between the bank and the terms, and more than
 * half of everybody who signed up stopped there. Confirming the account now
 * leads straight to the terms, whatever the conversation knows about an
 * email; the address is asked for after the first invoice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step } from "./machine.ts";

const V = "2026-09-draft-1";
const NAME = "DANIEL INIOBONG UWAK";
const EMAIL = "danny@balans.ng";

const confirm = (ctx: Record<string, unknown>, text: string) =>
  step("onboarding:confirm_account", ctx, { text, today: { y: 2026, m: 9, d: 22 } }, V);

describe("confirming the account", () => {
  it("goes straight to the terms on a yes, email or no email", () => {
    for (const ctx of [{ resolvedAccountName: NAME, email: EMAIL }, { resolvedAccountName: NAME }]) {
      const out = confirm(ctx, "yes");
      assert.equal(out.next, "onboarding:consent");
      assert.deepEqual(out.effects.map((e) => e.type), ["create_subaccount", "ask_consent"]);
    }
  });

  it("takes the button's own words", () => {
    assert.equal(confirm({ resolvedAccountName: NAME }, "✅ That's me".replace("✅ ", "")).next, "onboarding:consent");
  });

  it("asks for a yes, never for an email, when the answer is unclear", () => {
    const said = confirm({ resolvedAccountName: NAME }, "???").replies.join(" ");
    assert.doesNotMatch(said, /send your email/i);
    assert.match(said, /yes/i);
  });

  it("goes back to the bank on a no, keeping anything else it knew", () => {
    const out = confirm({ resolvedAccountName: NAME, email: EMAIL }, "no");
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.context.email, EMAIL);
  });
});
