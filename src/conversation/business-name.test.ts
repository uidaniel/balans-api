/**
 * What can be a business name, and what silently could not be.
 *
 * Two bugs, both found by reading a live payment page rather than a test.
 *
 * A real account is called "Delete My Account". Somebody typed that during
 * setup and it was taken as a name — it is letters, it is the right length,
 * and every rule let it through. It then printed on their invoices and on the
 * page their client opens.
 *
 * And the global commands were prefix matches with a word boundary, which
 * reads fine until somebody's business is called Stop Motion Studios. "Stop"
 * at the front matched CANCEL, setup restarted, and there was no name that
 * person could type to get past it: every attempt opened with the word that
 * threw the attempt away. Cancel Culture Media and Help Desk Nigeria are the
 * same trap, and Hi-Tech Solutions hit it on the greeting.
 *
 * The second is the worse one. A bad name is fixed in /settings in ten
 * seconds; a name that cannot be typed at all is somebody who never signs up
 * and never finds out why.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step, type Context, type State } from "./machine.ts";

const today = { y: 2026, m: 9, d: 23 };
const at = (state: State, text: string, ctx: Context = {}) =>
  step(state, ctx, { text, today }, "1.0");

/** Whether this got through setup as a name. */
const accepted = (name: string) => at("onboarding:business_name", name).next === "onboarding:bank";

describe("names people actually have", () => {
  for (const name of [
    "Kemi Adeyemi Studio",
    "9ja Prints",
    "247 Logistics",
    "Studio 54",
    "Premium Cuts",
    "Dashboard Digital",
    "Stop Motion Studios",
    "Cancel Culture Media",
    "Help Desk Nigeria",
    "Hi-Tech Solutions",
    "Delete Designs",
    "Restart Media",
    "Àkàndé & Sons",
  ]) {
    it(`lets somebody be called ${name}`, () => {
      assert.ok(accepted(name), `"${name}" could not finish setup`);
    });
  }
});

describe("things that are instructions, not names", () => {
  for (const said of [
    "delete my account",
    "Delete My Account",
    "close my account",
    "cancel my account",
    "stop",
    "help",
    "settings",
    "upgrade",
    "yes",
  ]) {
    it(`does not become a business called "${said}"`, () => {
      assert.ok(!accepted(said), `"${said}" was saved as a name`);
    });
  }

  it("says which kind of mistake it was", () => {
    // "That does not look like a business name" tells somebody nothing.
    const out = at("onboarding:business_name", "hello@kemi.ng");
    assert.match(out.replies[0]!, /email address/);
  });
});

describe("renaming from settings, which is the same field", () => {
  /*
   * The branch that actually corrupted the live account.
   *
   * `takeNewBusinessName` checked the length and nothing else, so everything
   * setup refuses — an email address, a URL, "delete my account" — was
   * accepted here and written straight onto the invoices. Two validators for
   * one field was the whole bug, so there is now one, and this asks both
   * paths the same questions.
   */
  const renamed = (name: string) =>
    at("settings:business_name" as State, name).effects.some((e) => e.type === "set_business_name");

  it("accepts the same names setup does", () => {
    for (const name of ["Kemi Adeyemi Studio", "Stop Motion Studios", "9ja Prints", "Premium Cuts"]) {
      assert.ok(renamed(name), `"${name}" should be allowed`);
      assert.ok(accepted(name), "and setup should agree");
    }
  });

  it("refuses the same things setup refuses", () => {
    for (const said of [
      "delete my account",
      "Delete My Account",
      "close my account",
      "help",
      "hello@kemi.ng",
      "https://kemi.ng",
      "/pro",
      "a",
    ]) {
      assert.ok(!renamed(said), `"${said}" was saved as a name from settings`);
      assert.ok(!accepted(said), "and setup should agree");
    }
  });

  it("says why, rather than just asking again", () => {
    const out = at("settings:business_name" as State, "hello@kemi.ng");
    assert.match(out.replies[0]!, /email address/);
  });
});

describe("the commands still being commands", () => {
  it("answers help mid-setup, with or without punctuation", () => {
    for (const text of ["help", "help!", "menu"]) {
      const out = at("onboarding:bank", text);
      assert.match(out.replies[0] ?? "", /bank/i, `"${text}" should still answer`);
    }
  });

  it("still restarts setup on the bare word", () => {
    for (const text of ["cancel", "stop", "restart", "start over"]) {
      const out = at("onboarding:bank", text);
      assert.deepEqual(
        out.effects.map((e) => e.type),
        ["send_flow"],
        `"${text}" should start again`,
      );
    }
  });

  it("still opens the menu on a greeting, including the words people add", () => {
    for (const text of ["hi", "hello", "hey there", "good morning sir", "how far"]) {
      const out = at("idle", text);
      assert.deepEqual(
        out.effects.map((e) => e.type),
        ["show_help"],
        `"${text}" should greet`,
      );
    }
  });

  it("does not read a name as a greeting", () => {
    assert.notDeepEqual(
      at("idle", "Hi-Tech Solutions").effects.map((e) => e.type),
      ["show_help"],
    );
  });
});

describe("changing your mind about a setting", () => {
  /*
   * From a live chat, and it ended with somebody's business name being
   * "I Dont Want To Change It Again" — printed on their invoices and on the
   * page their clients pay from.
   *
   * They had opened "change business name", thought better of it, and said
   * so. The question had no answer except the one it asked for: the sentence
   * is letters, it is the right length, and every rule the validator had let
   * it through. Twice before that they had typed "/pro", and were told twice
   * that it did not look like a business name — the escape was computed for
   * this state and simply never consulted.
   */
  const msg = (text: string, parsed?: unknown) =>
    ({ text, today: { y: 2026, m: 9, d: 23 }, parsed }) as never;

  const at = (text: string, parsed?: unknown) =>
    step("settings:business_name", { businessName: "Kemi Studio" }, msg(text, parsed), "1.0");

  it("takes no for an answer", () => {
    for (const said of [
      "i dont want to change it again",
      "I don't want to change it",
      "cancel",
      "never mind",
      "forget it",
      "leave it as it is",
      "no",
      "stop",
    ]) {
      const out = at(said);
      assert.equal(out.next, "idle", said);
      assert.deepEqual(out.effects, [], `${said} changed something`);
      assert.match(String(out.replies[0]), /Left it as it was/, said);
    }
  });

  it("lets a command out rather than arguing with it", () => {
    // "/pro" is somebody who has moved on. Telling them it is a bad name is
    // the bot refusing to notice.
    const out = at("/pro", { intent: "upgrade", confidence: 1 });
    assert.notEqual(out.next, "settings:business_name");
  });

  it("still takes a real name", () => {
    const out = at("Kemi Adeyemi Studio");
    assert.deepEqual(
      out.effects.map((e) => e.type),
      ["set_business_name"],
    );
  });

  it("still refuses one that is plainly not a name", () => {
    const out = at("kemi@studio.ng");
    assert.equal(out.next, "settings:business_name");
    assert.match(String(out.replies[0]), /email address/i);
  });
});
