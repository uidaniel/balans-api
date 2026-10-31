/**
 * What setup takes as a business name, and what it asks about instead
 * (31 October 2026).
 *
 * Accounts were called "Hi Balans": while the setup form was open, anything
 * typed that was not a bare "hi" became the name. The ads open with "Hi
 * Balans, I want to try it".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nameProblem, step } from "./machine.ts";

const go = (state: Parameters<typeof step>[0], text: string) =>
  step(state, {}, { text, today: { y: 2026, m: 10, d: 31 } }, "5.0");

describe("a business name", () => {
  for (const chatter of ["Hi Balans", "hi balans", "Hiii", "Hello", "Good morning", "Hi Balans, I want to try it", "I want to try it", "ok", "Thanks", "How does it work?", "Balans", "GTBank 0123456789"]) {
    it(`is not ${JSON.stringify(chatter)}`, () => assert.ok(nameProblem(chatter), chatter));
  }
  for (const name of ["Kemi Adeyemi Studio", "Hi-Tech Solutions", "Hilda Designs", "Sure Prints", "OK Motors", "Highland Media", "Okonkwo & Sons"]) {
    it(`can be ${JSON.stringify(name)}`, () => assert.equal(nameProblem(name), null, name));
  }
});

describe("typing while the setup form is open", () => {
  it("asks the question for a greeting or a message, and keeps nothing", () => {
    for (const text of ["Hi Balans", "Hi Balans, I want to try it", "how do I start?"]) {
      const out = go("onboarding:form", text);
      assert.equal(out.next, "onboarding:business_name", text);
      assert.equal(out.context.businessName, undefined, text);
      assert.match(out.replies.join(" "), /What is your business called/);
    }
  });

  it("still takes a real name typed instead of the form", () => {
    const out = go("onboarding:form", "Kemi Adeyemi Studio");
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.context.businessName, "Kemi Adeyemi Studio");
  });
});

describe("an email address sent after setup", () => {
  it("sends a confirmation link", () => {
    const out = go("idle", "Kemi@Studio.ng");
    assert.deepEqual(out.effects, [{ type: "send_email_link", email: "kemi@studio.ng" }]);
  });

  it("is not read out of a sentence", () => {
    const out = go("idle", "invoice kemi@studio.ng 20k");
    assert.ok(!out.effects.some((e) => e.type === "send_email_link"));
  });
});
