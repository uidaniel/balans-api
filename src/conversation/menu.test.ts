/**
 * What "/" and "help" answer with.
 *
 * The cheat sheet carries all ten commands as a picture; three buttons ride
 * under it for the things people actually open this to do. A list message
 * would have been the obvious shape and is not available — an image header on
 * `type: "list"` is rejected by Meta outright, while `type: "button"` takes
 * one.
 *
 * The invariant is the same as it was for the list: every button id is a
 * command the parser reads, so tapping and typing arrive at the same place.
 * Nothing in the types says so — an id is a string, and a renamed command
 * would leave a button that does nothing at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { helpButtons } from "./menu.ts";
import { asCommand } from "../parser/commands.ts";
import { step, VOICE } from "./machine.ts";
import type { Parsed } from "../parser/schema.ts";

const buttons = helpButtons();

/** What each button claims to do, by id. */
const PROMISED: Record<string, string> = {
  "/invoice": "create_invoice",
  "/owed": "debtors",
  "/summary": "summary",
};

describe("the help buttons", () => {
  it("fits what a message may carry", () => {
    // Meta rejects the whole message for a fourth button, which would take
    // the cheat sheet down with it.
    assert.ok(buttons.length >= 1 && buttons.length <= 3, `${buttons.length} buttons`);
  });

  it("stays inside the title limit without being truncated", () => {
    // `sendButtons` slices, so an over-long title does not fail — it arrives
    // on somebody's phone cut off mid-word.
    for (const b of buttons) {
      assert.ok(b.title.length <= 20, `"${b.title}" is ${b.title.length} characters`);
    }
  });

  it("gives every button a distinct id and title", () => {
    assert.equal(new Set(buttons.map((b) => b.id)).size, buttons.length);
    assert.equal(new Set(buttons.map((b) => b.title)).size, buttons.length);
  });

  it("makes every button a command the parser reads", () => {
    // The one that matters. A button whose id is not a command does nothing
    // when tapped, and nothing about it looks broken until somebody taps it.
    for (const b of buttons) {
      const command = asCommand(b.id);
      assert.ok(command, `${b.id} is not a command`);
      assert.equal(command.intent, PROMISED[b.id], `${b.id} does not do what it says`);
    }
  });

  it("promises nothing that is no longer offered", () => {
    assert.deepEqual(buttons.map((b) => b.id).sort(), Object.keys(PROMISED).sort());
  });
});

describe("everything that offers the menu offers the tappable one", () => {
  const V = "2026-09-draft-1";
  const ask = (text: string) => step("idle", {}, { text }, V);

  /** What the parser hands over for "/" and the other help commands. */
  const helpParse: Parsed = {
    intent: "help",
    correction: null,
    clientName: null,
    clientEmail: null,
    lineItems: [],
    totalKobo: null,
    dueDate: null,
    dueDatePhrase: null,
    documentNumber: null,
    options: {
      depositPercent: null,
      instalments: null,
      passFeesToClient: null,
      vatPercent: null,
      notes: null,
    },
    confidence: 1,
    source: "command",
    missing: [],
  };

  /*
   * The bug this is here for.
   *
   * The list was wired into the `show_help` effect and nowhere else, so "/"
   * was tappable and a plain "hey" was not — and "hey" is what somebody sends
   * when they have just been handed the number and have no idea what this is.
   * It went out as a wall of slash commands on a real phone.
   *
   * So the rule is stated as a rule: the typed menu may be a fallback, never
   * a reply. Anything that puts VOICE.helpIdle in `replies` has skipped the
   * list, whatever else it got right.
   */
  for (const text of ["hey", "hi", "how far", "help", "menu", "what can you do"]) {
    it(`"${text}" asks for the list`, () => {
      const out = ask(text);

      const effect = out.effects.find((e) => e.type === "show_help");
      assert.ok(effect, `"${text}" produced no show_help effect`);
      assert.equal(effect.fallback, VOICE.helpIdle, "the typed menu is the fallback");

      assert.ok(
        !out.replies.some((r) => r === VOICE.helpIdle),
        `"${text}" sent the typed menu as a reply, so the list was never tried`,
      );
    });
  }

  it('"/" gets there too, by the command reader rather than the machine', () => {
    // "/" is not matched by the machine's HELP pattern — `asCommand` reads it
    // and hands the machine a help intent, which is the path handle.ts takes
    // in production. Testing it without the parse would prove nothing about
    // either half.
    assert.equal(asCommand("/")?.intent, "help");

    const out = step("idle", {}, { text: "/", parsed: helpParse }, V);
    const effect = out.effects.find((e) => e.type === "show_help");
    assert.ok(effect, "a help intent must ask for the list");
    assert.equal(effect.fallback, VOICE.helpIdle);
    assert.ok(!out.replies.includes(VOICE.helpIdle), "not as words");
  });

  it("works from wherever somebody is stuck, keeping their draft", () => {
    /*
     * The bug this is here for.
     *
     * "/" only produced the menu from idle. Part-way through a draft it did
     * nothing at all — which is precisely when somebody reaches for it,
     * because that is when they are stuck and looking for a way out.
     *
     * And it must not cost them the draft. Asking what this thing can do is
     * not the same as abandoning what you were doing.
     */
    const doc = {
      type: "invoice" as const,
      clientName: "Tunde",
      lines: [{ description: "logo", qty: 1, unitAmountKobo: 20_000_00 }],
    };

    for (const state of ["awaiting_confirm", "awaiting_field:amount", "awaiting_field:client_name"] as const) {
      const out = step(state, { doc }, { text: "/", parsed: helpParse }, V);

      assert.ok(
        out.effects.some((e) => e.type === "show_help"),
        `"/" did nothing at ${state}`,
      );
      assert.equal(out.next, state, `${state}: help moved the conversation`);
      assert.deepEqual(out.context.doc, doc, `${state}: help lost the draft`);
    }
  });

  it("still answers about the question on screen mid-onboarding", () => {
    // The whole menu there would invite somebody to wander off a form they
    // are three fields into, so this one is deliberately not a list.
    const out = step("onboarding:bank", {}, { text: "help" }, V);
    assert.equal(out.effects.find((e) => e.type === "show_help"), undefined);
    assert.ok(out.replies.length > 0, "it must still say something");
    assert.notEqual(out.replies[0], VOICE.helpIdle, "and it must be about the bank question");
  });
});
