/**
 * The setup form's email survives a bank that does not resolve.
 *
 * The form collects the business name, the email and the bank in one submit.
 * When the bank half fails — a typo, a bank Monnify will not resolve, an
 * account that does not exist — the conversation picks up the bank on its own
 * and the rest of the form must not be thrown away with it.
 *
 * It was. The account was re-entered, resolved, and the bot then asked for an
 * email address that had been typed into the form two minutes earlier, which
 * reads as though nothing you did was saved.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step } from "./machine.ts";

const V = "2026-09-draft-1";
const NAME = "DANIEL INIOBONG UWAK";
const EMAIL = "danny@balans.ng";

const confirm = (ctx: Record<string, unknown>, text: string) =>
  step("onboarding:confirm_account", ctx, { text, today: { y: 2026, m: 9, d: 22 } }, V);

describe("confirming the account when the email is already known", () => {
  it("goes straight to the code, without asking again", () => {
    const out = confirm({ resolvedAccountName: NAME, email: EMAIL }, "yes");

    assert.equal(out.next, "onboarding:verify_email");
    assert.deepEqual(
      out.effects.map((e) => e.type).sort(),
      ["create_subaccount", "send_email_code"],
      "the code has to actually be sent, not just promised",
    );
    assert.match(out.replies.join(" "), new RegExp(EMAIL), "it should name the address it used");
  });

  it("sends the code to the address the form gave", () => {
    const out = confirm({ resolvedAccountName: NAME, email: EMAIL }, "yes");
    const sent = out.effects.find((e) => e.type === "send_email_code");
    assert.equal(sent?.email, EMAIL);
  });

  it("still asks when there is no email yet", () => {
    // Someone who typed their bank in words from the start never filled a
    // form, so there is nothing to remember and the question is right.
    const out = confirm({ resolvedAccountName: NAME }, "yes");
    assert.equal(out.next, "onboarding:email");
    assert.deepEqual(out.effects.map((e) => e.type), ["create_subaccount"]);
  });

  it("asks for a yes, not an email, when it already has one", () => {
    const known = confirm({ resolvedAccountName: NAME, email: EMAIL }, "???").replies.join(" ");
    assert.doesNotMatch(known, /send your email/i, "it asked for something it already had");
    assert.match(known, /yes/i);

    const unknown = confirm({ resolvedAccountName: NAME }, "???").replies.join(" ");
    assert.match(unknown, /email/i, "without one, it must still ask");
  });

  it("lets a different address override the one on file", () => {
    // The question is "is this you?", and answering with an address is still
    // a yes — to a different address. Somebody correcting a typo must be able
    // to, without starting over.
    const out = confirm({ resolvedAccountName: NAME, email: EMAIL }, "other@balans.ng");
    assert.equal(out.next, "onboarding:verify_email");
    assert.equal(out.context.email, "other@balans.ng");
    assert.equal(
      out.effects.find((e) => e.type === "send_email_code")?.email,
      "other@balans.ng",
    );
  });

  it("goes back to the bank on a no, keeping the email", () => {
    const out = confirm({ resolvedAccountName: NAME, email: EMAIL }, "no");
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.context.email, EMAIL, "a wrong bank is not a reason to re-ask the email");
  });
});
