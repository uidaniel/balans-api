/**
 * Somebody being a person.
 *
 * A user said "thank you" and was answered with "I only do quotes, invoices
 * and payments — try: Invoice Tunde 20k for logo design, due Friday". Every
 * word of that is accurate. It is still the wrong answer, because nobody
 * asked what this does, and it reads as a machine that was not listening —
 * the one impression a product living inside a chat cannot afford.
 *
 * The cause was that "thank you" and "can you do my taxes" were the same
 * intent. They need opposite answers: one asked for something out of scope
 * and is answered by saying what is in scope, the other asked for nothing.
 *
 * Matched before any model call, because these are the cheapest messages in
 * the product to recognise and were getting the most expensive possible
 * handling: a round trip to a model, to be told "unknown".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asCommand, socialKind } from "./commands.ts";
import { parseMessage } from "./parse.ts";
import { VOICE, step } from "../conversation/machine.ts";

const today = { y: 2026, m: 9, d: 23 };

/*
 * Through the real parser, not a hand-made parse.
 *
 * The whole point is that these never reach a model, so `parseMessage` runs
 * the pattern path and returns without a network call — and the test proves
 * that as a side effect: no fetch is provided, so anything that tried would
 * fail rather than quietly pass.
 */
async function say(text: string) {
  const out = await parseMessage(text, { today });
  assert.ok(out.ok, `could not parse "${text}"`);
  return step("idle", {}, { text, today, parsed: out.parsed }, "1.0");
}

describe("what counts as a pleasantry", () => {
  const cases: [string, ReturnType<typeof socialKind>][] = [
    ["thanks", "thanks"],
    ["Thank you", "thanks"],
    ["thank u", "thanks"],
    ["thanks boss", "thanks"],
    ["thanks a lot", "thanks"],
    ["God bless you", "thanks"],
    ["no wahala", "thanks"],
    ["appreciate it", "thanks"],
    ["hi", "greeting"],
    ["Hello", "greeting"],
    ["good morning", "greeting"],
    ["how far", "greeting"],
    // Nigerian English: a greeting to someone working, not a compliment.
    ["well done", "greeting"],
    ["nice one", "praise"],
    ["this is nice", "praise"],
    ["perfect", "praise"],
    ["i love it", "praise"],
    ["good night", "farewell"],
    ["bye", "farewell"],
    ["talk later", "farewell"],
  ];

  for (const [text, kind] of cases) {
    it(`reads "${text}" as ${kind}`, () => {
      assert.equal(socialKind(text), kind);
      assert.deepEqual(asCommand(text), { intent: "social", social: kind });
    });
  }

  it("ignores punctuation and case", () => {
    for (const t of ["THANKS!", "thank you.", "Hi!!", "good morning?"]) {
      assert.notEqual(socialKind(t), null, `"${t}" should still read as social`);
    }
  });
});

describe("what is not a pleasantry", () => {
  it("leaves real work alone", () => {
    // The failure that would matter: a greeting matcher swallowing an
    // instruction, so an invoice is answered with "Hello".
    for (const t of [
      "Invoice Tunde 20k for logo",
      "who owes me",
      "thanks, now invoice Tunde 20k",
      "hello can you invoice Tunde 20k",
      "good morning please send invoice 3 again",
    ]) {
      assert.equal(socialKind(t), null, `"${t}" is work, not small talk`);
    }
  });

  it("does not swallow a yes or a no", () => {
    // These arrive at a draft waiting to be sent, and turning one into a
    // pleasantry would leave the invoice unsent and say "Any time."
    for (const t of ["yes", "no", "ok", "send it", "cancel"]) {
      assert.equal(socialKind(t), null, `"${t}" has to stay an answer`);
      assert.notEqual(asCommand(t)?.intent, "social");
    }
  });

  it("gives up on anything long enough to be a sentence", () => {
    assert.equal(socialKind("thanks for all the work you did on the branding last month"), null);
  });
});

describe("what it replies", () => {
  it("answers a thank-you without selling anything", () => {
    // A prompt to go and invoice somebody, attached to "thanks", is a shop
    // assistant following you to the door.
    const reply = VOICE.social("thanks");
    assert.doesNotMatch(reply, /Invoice Tunde|who owes me|I only do/);
    assert.match(reply, /Any time/);
  });

  it("answers a greeting with the menu, not a sentence", async () => {
    // "hi" has always opened the tappable menu, and that is a better answer
    // than a line of prose: something to act on rather than words to retype.
    // Routed through the same branch so the pattern path and the model path
    // cannot answer the same "good morning" differently.
    const out = await say("good morning");
    assert.deepEqual(out.replies, []);
    assert.deepEqual(out.effects.map((e) => e.type), ["show_help"]);
  });

  it("never answers a pleasantry with the out-of-scope line", () => {
    for (const kind of ["thanks", "praise", "farewell"] as const) {
      assert.notEqual(VOICE.social(kind), VOICE.outOfScope);
      assert.doesNotMatch(VOICE.social(kind), /I only do quotes/);
    }
  });

  it("reaches the user, through the machine, with nothing else happening", async () => {
    const out = await say("thank you");
    assert.deepEqual(out.replies, [VOICE.social("thanks")]);
    assert.equal(out.next, "idle");
    assert.deepEqual(out.effects, [], "a pleasantry does not do anything");
  });

  it("answers each kind in its own words", async () => {
    assert.match((await say("nice one")).replies[0]!, /Glad it is working/);
    assert.match((await say("goodnight")).replies[0]!, /Talk soon/);
  });

  it("gets there without asking a model", async () => {
    // Every one of these is a pattern match. A model call for "thanks" is a
    // round trip and a bill for the most common message in the product.
    const out = await parseMessage("thank you", { today });
    assert.ok(out.ok);
    assert.equal(out.parsed.source, "command");
  });
});
