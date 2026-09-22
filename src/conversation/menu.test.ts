/**
 * The "/" menu.
 *
 * The whole point of the list is that tapping a row and typing the command are
 * the same message by the time anything reads them. That only holds while
 * every row id is something `asCommand` recognises, and nothing in the types
 * says it has to be — a row id is a string, and a renamed command would leave
 * a tappable row that does nothing at all.
 *
 * So the test that matters is the round trip: every row, through the real
 * command reader, landing on the intent the row promises.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mainMenuList } from "./menu.ts";
import { asCommand } from "../parser/commands.ts";
import { step, VOICE } from "./machine.ts";
import type { Parsed } from "../parser/schema.ts";

const list = mainMenuList();
const rows = list.sections.flatMap((s) => s.rows);

/** What each row claims to do, by id. */
const PROMISED: Record<string, string> = {
  "/invoice": "create_invoice",
  "/quote": "create_quote",
  "/collect": "payment_request",
  "/owed": "debtors",
  "/summary": "summary",
  "/status": "status",
  "/settings": "settings",
  "/design": "templates",
  "/pro": "upgrade",
};

describe("the menu list", () => {
  it("fits in a WhatsApp list", () => {
    // Meta rejects the whole message for an eleventh row, and `sendList`
    // refuses to send it rather than having it fail in production.
    assert.ok(rows.length <= 10, `${rows.length} rows is more than a list holds`);
    assert.ok(rows.length >= 1);
  });

  it("stays inside the field limits without being truncated", () => {
    // `sendList` slices, which means an over-long title does not fail — it
    // arrives on somebody's phone cut off mid-word.
    assert.ok(list.button.length <= 20, `button: ${list.button}`);
    assert.ok((list.header ?? "").length <= 60);
    assert.ok((list.footer ?? "").length <= 60, `footer: ${list.footer}`);

    for (const s of list.sections) {
      assert.ok((s.title ?? "").length <= 24, `section title: ${s.title}`);
    }
    for (const r of rows) {
      assert.ok(r.title.length <= 24, `row title: ${r.title} (${r.title.length})`);
      assert.ok((r.description ?? "").length <= 72, `row description: ${r.description}`);
    }
  });

  it("gives every row a distinct id and title", () => {
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "two rows share an id");
    assert.equal(new Set(rows.map((r) => r.title)).size, rows.length, "two rows read the same");
  });

  it("makes every row a command the parser reads", () => {
    // The one that matters. A row whose id is not a command is a row that does
    // nothing when tapped, and nothing about it looks broken until somebody
    // taps it.
    for (const row of rows) {
      const command = asCommand(row.id);
      assert.ok(command, `${row.id} is not a command`);
      assert.equal(command.intent, PROMISED[row.id], `${row.id} does not do what it says`);
    }
  });

  it("shows the command on the row that runs it", () => {
    // How somebody learns the word. Tapping teaches; typing is faster than
    // tapping, and they only get there if they have seen it written down.
    for (const row of rows) {
      assert.match(row.description ?? "", new RegExp(`^${row.id}\\b`), `${row.title}`);
    }
  });

  it("promises nothing the parser cannot do", () => {
    // Guards the other direction: a row removed from the list but left in
    // PROMISED would make the round-trip test pass over a row that is gone.
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      Object.keys(PROMISED).sort(),
      "the list and what it promises have drifted apart",
    );
  });
});

describe("everything that offers the menu offers the tappable one", () => {
  const V = "2026-09-draft-1";
  const ask = (text: string) => step("idle", {}, { text }, V);

  /** What the parser hands over for "/" and the other help commands. */
  const helpParse: Parsed = {
    intent: "help",
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

  it("still answers about the question on screen mid-onboarding", () => {
    // The whole menu there would invite somebody to wander off a form they
    // are three fields into, so this one is deliberately not a list.
    const out = step("onboarding:bank", {}, { text: "help" }, V);
    assert.equal(out.effects.find((e) => e.type === "show_help"), undefined);
    assert.ok(out.replies.length > 0, "it must still say something");
    assert.notEqual(out.replies[0], VOICE.helpIdle, "and it must be about the bank question");
  });
});
