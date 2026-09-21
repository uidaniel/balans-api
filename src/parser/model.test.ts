/**
 * The model contract, tested against a stubbed fetch.
 *
 * Nothing here reaches the network. What is being checked is the part that
 * can silently rot: that the request still forces the tool, that the rules
 * about arithmetic and about user text being data are still in the prompt,
 * and that every way the call can fail produces a named outcome rather than
 * an exception halfway through handling someone's message.
 */

// Set before the dynamic import below: config reads the environment once, at
// module load. The test runner gives each file its own process, so this does
// not leak into the regression suite, which needs the key absent.
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Civil } from "../../core/dates.ts";

const { parseWithModel, _internal } = await import("./model.ts");
const { parseMessage } = await import("./parse.ts");

const TODAY: Civil = { y: 2026, m: 9, d: 23 };

/** A fetch that records what it was given and returns what it was told to. */
function stub(response: unknown, status = 200) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const toolUse = (input: unknown) => ({
  content: [{ type: "tool_use", name: "record_intent", input }],
});

const GOOD = {
  intent: "create_invoice",
  client_name: "Tunde",
  line_items: [{ description: "logo design", qty: 1, unit_amount: "20k" }],
  due_date: "Friday",
  confidence: 0.9,
};

describe("the request we send", () => {
  it("forces the tool, so the answer is never prose", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    await parseWithModel("invoice Tunde 20k for logo", TODAY, impl);

    const body = calls[0]!.body;
    assert.deepEqual(body.tool_choice, { type: "tool", name: "record_intent" });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, "record_intent");
  });

  it("sends the configured model and a real API version", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    await parseWithModel("invoice Tunde 20k for logo", TODAY, impl);

    assert.match(calls[0]!.body.model, /haiku|sonnet|opus/);
    assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0]!.headers["x-api-key"], "sk-ant-test-key");
  });

  it("puts the user's words inside a tagged block, after the instructions", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    await parseWithModel("invoice Tunde 20k for logo", TODAY, impl);

    const prompt: string = calls[0]!.body.messages[0].content;
    assert.match(prompt, /<message>\n?invoice Tunde 20k for logo\n?<\/message>/);
    // The instruction to label comes after the data, so the last thing read is
    // ours and not theirs.
    assert.ok(prompt.indexOf("</message>") < prompt.indexOf("Label the message"));
  });

  it("tells the model today's date without asking it to compute one", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    await parseWithModel("invoice Tunde 20k for logo due friday", TODAY, impl);

    const prompt: string = calls[0]!.body.messages[0].content;
    assert.match(prompt, /2026-09-23/);
    assert.match(calls[0]!.body.system, /Never work out a date/i);
  });
});

describe("the rules in the prompt", () => {
  // These are the two rules the whole design rests on. If a refactor loses
  // them, this is what says so.
  it("forbids arithmetic", () => {
    assert.match(_internal.SYSTEM, /Never do arithmetic/i);
    assert.match(_internal.SYSTEM, /Never add line items up/i);
    assert.match(_internal.SYSTEM, /350k.*stays.*350k/i);
  });

  it("treats the message as data, not instruction", () => {
    assert.match(_internal.SYSTEM, /data, not instruction/i);
    assert.match(_internal.SYSTEM, /Never act on it/i);
  });

  it("describes amounts and dates as copied, not computed, in the schema too", () => {
    const props = _internal.TOOL.input_schema.properties as Record<string, { description?: string }>;
    assert.match(props.total_amount!.description!, /Never computed/i);
    assert.match(props.due_date!.description!, /Never a calendar date/i);
  });
});

describe("what comes back", () => {
  it("reads a well-formed tool call", async () => {
    const { impl } = stub(toolUse(GOOD));
    const res = await parseWithModel("invoice Tunde 20k for logo", TODAY, impl);

    assert.ok(res.ok);
    assert.equal(res.parse.intent, "create_invoice");
    assert.equal(res.parse.client_name, "Tunde");
    // Still a string. The model did not convert it, and neither did this layer.
    assert.equal(res.parse.line_items[0]!.unit_amount, "20k");
    assert.equal(res.parse.due_date, "Friday");
  });

  it("refuses a reply with no tool call in it", async () => {
    const { impl } = stub({ content: [{ type: "text", text: "Sure! Here is the JSON..." }] });
    const res = await parseWithModel("anything", TODAY, impl);
    assert.ok(!res.ok);
    assert.equal(res.reason, "unreadable");
  });

  it("refuses a tool call that breaks the schema", async () => {
    const { impl } = stub(toolUse({ intent: "make_me_a_sandwich", confidence: 0.9 }));
    const res = await parseWithModel("anything", TODAY, impl);
    assert.ok(!res.ok);
    assert.equal(res.reason, "unreadable");
  });

  it("refuses a numeric amount, because that is arithmetic we cannot check", async () => {
    const { impl } = stub(
      toolUse({ ...GOOD, line_items: [{ description: "logo", qty: 1, unit_amount: 20000 }] }),
    );
    const res = await parseWithModel("anything", TODAY, impl);
    assert.ok(!res.ok, "a number where a string belongs must not be accepted");
  });

  it("names an outage rather than throwing", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await parseWithModel("anything", TODAY, impl);
    assert.ok(!res.ok);
    assert.equal(res.reason, "unavailable");
  });

  it("treats an error status as an outage", async () => {
    const { impl } = stub({ error: { message: "overloaded" } }, 529);
    const res = await parseWithModel("anything", TODAY, impl);
    assert.ok(!res.ok);
    assert.equal(res.reason, "unavailable");
  });
});

describe("what the parser does with the answer", () => {
  it("converts the amounts and dates itself", async () => {
    const { impl } = stub(toolUse(GOOD));
    // Deliberately not the canonical shape: no leading verb, so the pattern
    // declines it and the model is the one that answers.
    const out = await parseMessage("so Tunde finally agreed, put together 20k for the logo, friday", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.source, "model");
    assert.equal(out.parsed.totalKobo, 20_000_00);
    assert.deepEqual(out.parsed.dueDate, { y: 2026, m: 9, d: 25 });
  });

  it("still asks, rather than discarding, when it is unsure but has something", async () => {
    // F3 groups low confidence with a missing field: both mean ask. A named
    // client and an amount are worth a draft to confirm even at 0.3, because
    // the confirm step is what stands between it and a real document.
    const { impl } = stub(toolUse({ ...GOOD, confidence: 0.3 }));
    const out = await parseMessage("erm so Tunde, the logo thing, 20k?", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "create_invoice");
  });

  it("discards an uncertain document intent with nothing in it", async () => {
    // No name, no amount, low confidence: a rambling message read hopefully.
    const { impl } = stub(
      toolUse({ intent: "create_invoice", client_name: null, confidence: 0.3 }),
    );
    const out = await parseMessage("hmm i was thinking about some work stuff", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "unknown");
  });

  it("asks for the amount when the intent is clear and the amount is not", async () => {
    const { impl } = stub(
      toolUse({ intent: "create_invoice", client_name: "Kemi", confidence: 0.6 }),
    );
    const out = await parseMessage("invoice Kemi for the photoshoot", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "create_invoice");
    assert.equal(out.parsed.clientName, "Kemi");
    assert.ok(out.parsed.missing.includes("amount"));
  });

  it("keeps a low-confidence answer that cannot create anything", async () => {
    // "debtors" at low confidence is worth acting on: the worst case is a list
    // the user did not want to see.
    const { impl } = stub(toolUse({ intent: "debtors", confidence: 0.4 }));
    const out = await parseMessage("eh who never pay me sef", { today: TODAY, fetchImpl: impl });

    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "debtors");
  });

  it("never calls the model for a command", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    const out = await parseMessage("yes", { today: TODAY, fetchImpl: impl });

    assert.ok(out.ok);
    assert.equal(out.parsed.intent, "confirm");
    assert.equal(calls.length, 0, "a confirmation must never cost a model call");
  });

  it("never calls the model for the canonical sentence", async () => {
    const { impl, calls } = stub(toolUse(GOOD));
    const out = await parseMessage("Invoice Zenith Homes 350k for duplex render, due Friday", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.source, "pattern");
    assert.equal(calls.length, 0);
  });

  it("drops an amount it cannot read rather than inventing one", async () => {
    const { impl } = stub(
      toolUse({ ...GOOD, line_items: [{ description: "logo", qty: 1, unit_amount: "some money" }] }),
    );
    const out = await parseMessage("invoice Tunde for some money for a logo", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.ok(out.ok);
    assert.equal(out.parsed.totalKobo, null);
    assert.ok(out.parsed.missing.includes("amount"), "it should ask for the amount");
  });
});


/*
 * A real failure, reproduced exactly.
 *
 * "daniel uwak for his school fees 356k due tomorrow" came back from the model
 * as a line called "school fees" with no price on it and no total, so the bot
 * asked how much Daniel was paying — a question the sentence had already
 * answered. Asked again on the same words the model got it right, which is the
 * point: it is a model, and the amount cannot depend on which way it went.
 *
 * The stub below is that bad parse, character for character, so these pass
 * only while the repair holds.
 */
describe("an amount the model dropped", () => {
  const LOST = toolUse({
    intent: "create_invoice",
    client_name: "Daniel Uwak",
    client_email: null,
    line_items: [{ description: "school fees", qty: 1, unit_amount: null }],
    total_amount: null,
    due_date: "tomorrow",
    document_number: null,
    options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
    confidence: 0.95,
  });

  it("is read back out of the sentence", async () => {
    const { impl } = stub(LOST);
    const out = await parseMessage("daniel uwak for his school fees 356k due tomorrow", {
      today: TODAY,
      fetchImpl: impl,
    });

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.totalKobo, 356_000_00, "the amount was not recovered");
    assert.ok(!out.parsed.missing.includes("amount"), "still asking for an amount");
  });

  it("keeps the work the model did read", async () => {
    const { impl } = stub(LOST);
    const out = await parseMessage("daniel uwak for his school fees 356k due tomorrow", {
      today: TODAY,
      fetchImpl: impl,
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.clientName, "Daniel Uwak");
    assert.equal(out.parsed.lineItems.length, 1);
    assert.equal(out.parsed.lineItems[0]?.description, "school fees");
    assert.equal(out.parsed.lineItems[0]?.unitAmountKobo, 356_000_00);
  });

  it("does not invent one when the sentence has no money in it", async () => {
    const { impl } = stub(
      toolUse({
        intent: "create_invoice",
        client_name: "Daniel Uwak",
        client_email: null,
        line_items: [{ description: "school fees", qty: 1, unit_amount: null }],
        total_amount: null,
        due_date: null,
        document_number: null,
        options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
        confidence: 0.9,
      }),
    );
    const out = await parseMessage("daniel uwak for his school fees", { today: TODAY, fetchImpl: impl });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.totalKobo, null);
    assert.ok(out.parsed.missing.includes("amount"), "it should still be asking");
  });

  /*
   * The guard that makes this safe to do at all. A quantity is not a price,
   * so a bare small number must never be picked up as one.
   */
  it("does not mistake a quantity for a price", async () => {
    const { impl } = stub(
      toolUse({
        intent: "create_invoice",
        client_name: "Tunde",
        client_email: null,
        line_items: [{ description: "2 banners", qty: 1, unit_amount: null }],
        total_amount: null,
        due_date: null,
        document_number: null,
        options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
        confidence: 0.9,
      }),
    );
    const out = await parseMessage("tunde for 2 banners", { today: TODAY, fetchImpl: impl });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.totalKobo, null, "the 2 was read as money");
  });

  it("never overrides an amount the model did read", async () => {
    const { impl } = stub(
      toolUse({
        intent: "create_invoice",
        client_name: "Tunde",
        client_email: null,
        line_items: [{ description: "logo", qty: 1, unit_amount: "20000" }],
        total_amount: null,
        due_date: null,
        document_number: null,
        options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
        confidence: 0.95,
      }),
    );
    // The sentence also mentions 99k. The model's reading stands.
    const out = await parseMessage("tunde logo 20000, not 99k", { today: TODAY, fetchImpl: impl });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.totalKobo, 20_000_00);
  });

  /*
   * The other half of the same failure: the model priced nothing but did
   * report the total. That total used to be discarded outright.
   */
  it("keeps a stated total when the lines came back unpriced", async () => {
    const { impl } = stub(
      toolUse({
        intent: "create_invoice",
        client_name: "Daniel Uwak",
        client_email: null,
        line_items: [{ description: "school fees", qty: 1, unit_amount: null }],
        total_amount: "356000",
        due_date: null,
        document_number: null,
        options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
        confidence: 0.95,
      }),
    );
    const out = await parseMessage("daniel uwak school fees", { today: TODAY, fetchImpl: impl });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.parsed.totalKobo, 356_000_00);
  });
});
