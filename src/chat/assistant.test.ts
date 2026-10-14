/**
 * The assistant (src/chat), without a network or a database.
 *
 * What is tested is everything around the model: which buttons survive, what
 * an answer looks like by the time it reaches WhatsApp, the daily cap, the
 * lookup loop, and that a failure says so rather than sending nothing.
 */

// Before the dynamic import: config reads the environment once, at load.
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Deps } from "./assistant.ts";

const { asked, buttonsFrom, converse, inHouseStyle, numbersIn, recentTurns } = await import("./assistant.ts");
const { asCommand } = await import("../parser/commands.ts");

const TODAY = { y: 2026, m: 10, d: 14 };

describe("the buttons it may offer", () => {
  const seen = new Set(["4", "12"]);

  it("keeps the ones on the list and drops the rest", () => {
    const out = buttonsFrom(["resend invoice 4", "delete my account", "mark invoice 4 paid", "send money to 0123"], seen);
    assert.deepEqual(out, [
      { id: "resend invoice 4", title: "Resend #4" },
      { id: "mark invoice 4 paid", title: "Mark #4 paid" },
    ]);
  });

  it("never offers a numbered button for a document it did not look up", () => {
    // 14 October 2026: "Edit #4" was offered for an invoice never looked at.
    assert.deepEqual(buttonsFrom(["edit invoice 7"], seen), []);
    assert.deepEqual(buttonsFrom(["edit invoice 12"], seen), [{ id: "edit invoice 12", title: "Edit #12" }]);
  });

  it("offers at most three, once each, with titles WhatsApp accepts", () => {
    const out = buttonsFrom(["who owes me", "who owes me", "summary", "settings", "designs", "help"], seen);
    assert.equal(out.length, 3);
    assert.equal(new Set(out.map((b) => b.id)).size, 3);
    for (const b of buttonsFrom(["stop reminders 12", "check invoice 4", "upgrade"], seen)) {
      assert.ok(b.title.length <= 20, `${b.title} is longer than Meta allows`);
    }
  });

  it("tolerates a hash and capitals", () => {
    assert.deepEqual(buttonsFrom(["Resend invoice #4"], seen), [{ id: "resend invoice 4", title: "Resend #4" }]);
  });

  it("only offers buttons the scripted path already understands", () => {
    // A tapped button arrives as its id. Each must still read as the command
    // it stands for, or the tap lands on "I could not read that".
    const expect: [string, string][] = [
      ["/invoice", "create_invoice"],
      ["/quote", "create_quote"],
      ["who owes me", "debtors"],
      ["summary", "summary"],
      ["check invoice 4", "status"],
      ["resend invoice 4", "resend_document"],
      ["edit invoice 4", "edit_document"],
      ["mark invoice 4 paid", "record_payment"],
      ["stop reminders 4", "stop_reminders"],
      ["convert quote 4", "convert_quote"],
      ["settings", "settings"],
      ["designs", "templates"],
      ["signature", "signature"],
      ["upgrade", "upgrade"],
      ["help", "help"],
    ];
    for (const [id, intent] of expect) {
      assert.equal(buttonsFrom([id], new Set(["4"])).length, 1, `${id} is not on the list`);
      assert.equal(asCommand(id)?.intent, intent, `${id} no longer reads as ${intent}`);
    }
  });

  it("offers to stop reminders only to somebody asking to stop them", () => {
    const stop = { id: "stop reminders 4", title: "Stop reminders 4" };
    assert.equal(asked("send a reminder to Tunde now")(stop), false);
    assert.equal(asked("delete invoice 4")(stop), false);
    assert.equal(asked("how do I stop the reminders for Tunde")(stop), true);
    assert.equal(asked("turn reminders off for invoice 4")(stop), true);
    assert.equal(asked("anything")({ id: "resend invoice 4", title: "Resend #4" }), true);
  });

  it("reads document numbers out of a lookup", () => {
    assert.deepEqual(numbersIn(`[{"ref":"Invoice #4"},{"ref":"Quote #12"}]`), ["4", "12"]);
  });
});

describe("an answer, by the time it reaches WhatsApp", () => {
  it("bolds the WhatsApp way and drops headings", () => {
    assert.equal(inHouseStyle("📄 **Invoice #4** is late\n## Next"), "📄 *Invoice #4* is late\nNext");
  });

  it("opens with an emoji, like every other message", () => {
    assert.equal(inHouseStyle("Tunde has not paid yet."), "💬 Tunde has not paid yet.");
    assert.equal(inHouseStyle("🔒 Safe."), "🔒 Safe.");
  });

  it("is never a wall of text", () => {
    assert.ok(inHouseStyle(`💬 ${"word ".repeat(600)}`).length <= 1500);
  });
});

describe("what it remembers", () => {
  const at = Date.UTC(2026, 9, 14, 12);
  const memory = { at: new Date(at).toISOString(), turns: [{ role: "user" as const, text: "how much did I make" }] };

  it("keeps the last few turns for half an hour", () => {
    assert.equal(recentTurns(memory, at + 10 * 60_000).length, 1);
    assert.equal(recentTurns(memory, at + 31 * 60_000).length, 0);
    assert.equal(recentTurns(undefined, at).length, 0);
  });
});

/* -------------------------------------------------------------------------- */

type Sent = { tools?: unknown[]; tool_choice?: unknown; messages: { role: string; content: unknown }[] };

function fakeApi(replies: object[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Sent);
    const next = replies.shift();
    if (!next) return new Response("no more", { status: 500 });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const final = (reply: string, actions: string[] = []) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ reply, actions }) }],
});

const base = (over: Partial<Deps> = {}): Deps => ({
  snapshot: async () => null,
  usedToday: async () => 0,
  plan: async () => "free",
  record: async () => undefined,
  runTool: async () => ({}),
  ...over,
});

describe("answering a question", () => {
  it("looks something up, then answers with it", async () => {
    const calls: [string, unknown][] = [];
    const { sent, fetchImpl } = fakeApi([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "get_document", input: { number: 4 } }],
      },
      final("📄 Tunde opened *invoice #4* on Thu, 1 Oct.", ["resend invoice 4", "edit invoice 9"]),
    ]);
    const out = await converse(
      { userId: "u1", text: "has Tunde opened invoice 4?", today: TODAY },
      base({
        fetchImpl,
        runTool: async (name, input) => {
          calls.push([name, input]);
          return { ref: "Invoice #4", opened_by_client: "Thu, 1 Oct" };
        },
      }),
    );

    assert.ok(out.ok);
    assert.deepEqual(calls, [["get_document", { number: 4 }]]);
    assert.match(out.reply, /invoice #4/);
    // #9 was never looked up, so it is not offered.
    assert.deepEqual(out.buttons, [{ id: "resend invoice 4", title: "Resend #4" }]);
    // The lookup went back with the id it answered.
    const second = sent[1]!.messages.at(-1)!.content as { tool_use_id: string; content: string }[];
    assert.equal(second[0]!.tool_use_id, "t1");
    assert.match(second[0]!.content, /Invoice #4/);
    // And the question went in as data, with today's date beside it.
    assert.match(String(sent[0]!.messages[0]!.content), /<message>\nhas Tunde opened invoice 4\?\n<\/message>/);
    assert.match(String(sent[0]!.messages[0]!.content), /Wednesday 2026-10-14/);
    // Remembered for the next question.
    assert.deepEqual(out.memory.turns.map((t) => t.role), ["user", "assistant"]);
  });

  it("stops looking after a few rounds and answers with what it has", async () => {
    const lookup = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "get_account", input: {} }] };
    const { sent, fetchImpl } = fakeApi([lookup, lookup, lookup, lookup, final("💬 Here is what I found.")]);
    const out = await converse({ userId: "u1", text: "tell me everything", today: TODAY }, base({ fetchImpl }));
    assert.ok(out.ok);
    assert.deepEqual(sent.at(-1)!.tool_choice, { type: "none" });
  });

  it("says no once the day's answers are used up, without calling the model", async () => {
    const { sent, fetchImpl } = fakeApi([final("💬 hi")]);
    const out = await converse(
      { userId: "u1", text: "why has Tunde not paid?", today: TODAY },
      base({ fetchImpl, usedToday: async () => 20, plan: async () => "free" }),
    );
    assert.deepEqual(out, { ok: false, reason: "limit" });
    assert.equal(sent.length, 0);
  });

  it("gives Pro more answers a day than Free", async () => {
    const { fetchImpl } = fakeApi([final("💬 hi")]);
    const out = await converse(
      { userId: "u1", text: "why has Tunde not paid?", today: TODAY },
      base({ fetchImpl, usedToday: async () => 20, plan: async () => "pro" }),
    );
    assert.ok(out.ok);
  });

  it("reports a refusal, an outage and nonsense as failures, never as an empty answer", async () => {
    for (const [reply, reason] of [
      [{ stop_reason: "refusal", content: [] }, "refused"],
      [{ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }, "unreadable"],
      [{ stop_reason: "end_turn", content: [{ type: "text", text: '{"reply":"","actions":[]}' }] }, "unreadable"],
    ] as const) {
      const { fetchImpl } = fakeApi([reply]);
      const out = await converse({ userId: "u1", text: "hi", today: TODAY }, base({ fetchImpl }));
      assert.deepEqual(out, { ok: false, reason });
    }
    const { fetchImpl } = fakeApi([]);
    assert.deepEqual(await converse({ userId: "u1", text: "hi", today: TODAY }, base({ fetchImpl })), {
      ok: false,
      reason: "unavailable",
    });
  });

  it("records every answer, for the cap and the 30-day log", async () => {
    const rows: { ok: boolean }[] = [];
    const { fetchImpl } = fakeApi([final("💬 hi")]);
    await converse({ userId: "u1", text: "hi", today: TODAY }, base({ fetchImpl, record: async (r) => void rows.push(r) }));
    assert.deepEqual(rows.map((r) => r.ok), [true]);
  });

  it("carries a recent conversation into the next question", async () => {
    const { sent, fetchImpl } = fakeApi([final("💬 Last month was ₦90,000.")]);
    await converse(
      {
        userId: "u1",
        text: "and last month?",
        today: TODAY,
        memory: {
          at: new Date().toISOString(),
          turns: [
            { role: "user", text: "how much did I make this month" },
            { role: "assistant", text: "💰 ₦100,000 so far." },
          ],
        },
      },
      base({ fetchImpl }),
    );
    assert.deepEqual(sent[0]!.messages.map((m) => m.role), ["user", "assistant", "user"]);
  });
});
