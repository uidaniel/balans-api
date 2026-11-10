/** The daily review of the bot's answers (5 November 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maskText } from "./turns.ts";
import { casesFrom, flagsFor, type Turn } from "./daily.ts";

const at = (m: number) => new Date(Date.UTC(2026, 10, 5, 9, m));
const turn = (o: Partial<Turn>): Turn => ({
  id: "1", user_id: "u", at: at(0), kind: "text", inbound: "hi", quoted: false, reply: "Hello", intent: null, confidence: null, model: null, ...o,
});

describe("what is kept", () => {
  it("masks numbers, emails and links, and keeps what was meant", () => {
    const m = maskText("Invoice Tunde 150k, his number is 08031234567, pay to 0123456789, email tunde@zenith.ng, see https://balans.ng/i/abc");
    assert.match(m, /Invoice Tunde 150k/);
    assert.match(m, /\[number …567\]/);
    assert.match(m, /\[number …789\]/);
    assert.match(m, /\[email\]@zenith\.ng/);
    assert.match(m, /\[link\]/);
    assert.doesNotMatch(m, /08031234567|0123456789|tunde@/);
  });

  it("leaves amounts and dates alone", () => {
    assert.equal(maskText("350,000 due 12 Nov"), "350,000 due 12 Nov");
  });
});

describe("what looks wrong", () => {
  it("a fallback reply, a failed or unsure reading, a reply to a card", () => {
    assert.deepEqual(flagsFor(turn({ reply: "🔍 Which one?\nTry status invoice 3" }), null), ["fallback reply"]);
    assert.deepEqual(flagsFor(turn({ model: "claude-haiku-5-5 (failed)" }), null), ["model failed"]);
    assert.deepEqual(flagsFor(turn({ confidence: 0.4 }), null), ["model unsure"]);
    assert.deepEqual(flagsFor(turn({ quoted: true }), null), ["replied to a card"]);
  });

  it("the same thing again, or a no, straight after", () => {
    const t = turn({ inbound: "did you send it?" });
    assert.ok(flagsFor(t, turn({ at: at(1), inbound: "Did you send it??" })).includes("sent again"));
    assert.ok(flagsFor(t, turn({ at: at(1), inbound: "no wrong" })).includes("pushed back after"));
    assert.deepEqual(flagsFor(t, turn({ at: at(30), inbound: "no" })), []);
  });

  it("an ordinary exchange is not flagged", () => {
    assert.deepEqual(flagsFor(turn({ inbound: "Invoice Tunde 20k for logo", reply: "Here's your draft" }), null), []);
  });

  it("gathers cases with the turn before and after, most flags first", () => {
    const cases = casesFrom([
      turn({ id: "a", at: at(0), inbound: "yo", reply: "Hey" }),
      turn({ id: "b", at: at(1), inbound: "reverse it", quoted: true, reply: "🔍 Which one?" }),
      turn({ id: "c", at: at(2), inbound: "???", reply: "🤔 I could not read that one." }),
    ]);
    assert.equal(cases[0]!.user, "reverse it");
    assert.deepEqual(cases[0]!.flags, ["fallback reply", "replied to a card", "pushed back after"]);
    assert.match(cases[0]!.before!, /User: yo/);
    assert.match(cases[0]!.after!, /User: \?\?\?/);
  });
});

describe("every kind of answer is recorded (9 November 2026)", async () => {
  const { describeSent } = await import("./turns.ts");
  it("a PDF, a list, a form and buttons read as what they are", () => {
    assert.equal(describeSent({ type: "document", document: { filename: "Invoice-0001.pdf", caption: "Here it is" } }), "[PDF: Invoice-0001.pdf] Here it is");
    assert.match(describeSent({ type: "interactive", interactive: { type: "list", body: { text: "Settings" }, action: { sections: [{ rows: [{ title: "Business name" }, { title: "Bank" }] }] } } })!, /Settings\n\[list: Business name \| Bank\]/);
    assert.match(describeSent({ type: "interactive", interactive: { type: "flow", body: { text: "Set up" }, action: { parameters: { flow_cta: "Get started" } } } })!, /\[form: Get started\]/);
    assert.match(describeSent({ type: "interactive", interactive: { type: "button", body: { text: "Send it?" }, action: { buttons: [{ reply: { title: "Send it" } }] } } })!, /\[buttons: Send it\]/);
  });
});

describe("settings let go of a sentence (9 November 2026)", async () => {
  const { step } = await import("../conversation/machine.ts");
  const at = (text: string) => step("settings:menu", {}, { text, today: { y: 2026, m: 11, d: 9 } } as never, "5.2");
  it("answers a sentence from idle instead of asking for a number again", () => {
    const r = at("Have not received the money");
    assert.equal(r.next, "idle");
    assert.deepEqual(r.effects, [{ type: "replay_text", text: "Have not received the money" }]);
  });
  it("shows the list again for a number that is not on it", () => {
    const r = at("1234");
    assert.equal(r.next, "settings:menu");
    assert.deepEqual(r.effects, [{ type: "show_settings" }]);
  });
  it("still takes the menu's own rows", () => {
    assert.equal(at("2").next, "settings:bank_code");
    assert.equal(at("cancel").next, "idle");
  });
});

describe("settings, asked which number", async () => {
  const { step } = await import("../conversation/machine.ts");
  it("shows the list again", () => {
    const r = step("settings:menu", {}, { text: "Which number on the list", today: { y: 2026, m: 11, d: 9 } } as never, "5.2");
    assert.equal(r.next, "settings:menu");
    assert.deepEqual(r.effects, [{ type: "show_settings" }]);
  });
});
