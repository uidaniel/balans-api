import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { step, VOICE, type Context, type State } from "./machine.ts";
import type { Parsed } from "../parser/schema.ts";
import type { Civil } from "../../core/dates.ts";
import type { Correction } from "../parser/corrections.ts";

const V = "2026-09-draft-1";
const go = (state: State, ctx: Context, text: string) => step(state, ctx, { text }, V);

/** Walks the whole flow, returning every state it passed through. */
function walk(inputs: string[]): {
  states: State[];
  ctx: Context;
  replies: string[];
  acks: string[];
} {
  let state: State = "new";
  let ctx: Context = {};
  const states: State[] = [];
  const replies: string[] = [];
  const acks: string[] = [];
  for (const text of inputs) {
    const out = go(state, ctx, text);
    state = out.next;
    ctx = out.context;
    states.push(state);
    replies.push(...out.replies);
    acks.push(...(out.ack ?? []));
  }
  return { states, ctx, replies, acks };
}

describe("onboarding: the happy path", () => {
  const { states, ctx } = walk([
    "Hi",
    "Kemi Adeyemi Studio",
    "GTBank 0123456789",
    "kemi@studio.ng",
    "123456",
    "I agree",
  ]);

  it("ends idle, set up", () => assert.equal(states.at(-1), "idle"));
  it("visits each step once, in order", () => {
    // No separate email step: confirming the account and giving the address are
    // the same turn, because the confirm question asks for the address.
    assert.deepEqual(states, [
      // "Hi" opens the setup form. Typing instead of filling it in is the
      // supported fallback, and what this walk does from here.
      "onboarding:form",
      "onboarding:bank",
      "onboarding:confirm_account",
      "onboarding:verify_email",
      "onboarding:consent",
      "idle",
    ]);
  });
  it("keeps what it was told", () => {
    assert.equal(ctx.businessName, "Kemi Adeyemi Studio");
    assert.equal(ctx.bankName, "GTBank");
    assert.equal(ctx.accountNumber, "0123456789");
    assert.equal(ctx.email, "kemi@studio.ng");
  });
});

describe("bank details, as people actually type them", () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ["GTBank 0123456789", "GTBank", "0123456789"],
    ["0123456789 GTBank", "GTBank", "0123456789"],
    ["Access Bank 1960725673", "Access Bank", "1960725673"],
    ["my bank is Zenith, 0123456789", "my bank is Zenith,", "0123456789"],
    ["UBA  0123456789 ", "UBA", "0123456789"],
  ];
  for (const [input, bank, account] of cases) {
    it(JSON.stringify(input), () => {
      const out = go("onboarding:bank", { businessName: "X" }, input);
      assert.equal(out.context.bankName, bank);
      assert.equal(out.context.accountNumber, account);
      assert.equal(out.next, "onboarding:confirm_account");
      assert.equal(out.effects[0]?.type, "resolve_account");
    });
  }

  it("asks again when there is no 10-digit number", () => {
    const out = go("onboarding:bank", {}, "GTBank");
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.effects.length, 0);
  });

  it("asks which bank when only a number arrives", () => {
    const out = go("onboarding:bank", {}, "0123456789");
    assert.equal(out.next, "onboarding:bank");
    assert.match(out.replies[0]!, /which bank/i);
  });
});

describe("a command always beats a pending question", () => {
  // PRD section 5: users are never trapped.
  const states: State[] = [
    "onboarding:business_name",
    "onboarding:bank",
    "onboarding:confirm_account",
    "onboarding:email",
    "onboarding:verify_email",
    "onboarding:consent",
  ];

  for (const state of states) {
    it(`help works at ${state}`, () => {
      const out = go(state, {}, "help");
      assert.equal(out.next, state, "help must not move the conversation");
      assert.ok(out.replies[0]!.length > 10);
    });
  }

  it("cancel restarts onboarding", () => {
    const out = go("onboarding:verify_email", { businessName: "X", email: "a@b.ng" }, "cancel");
    assert.equal(out.next, "onboarding:business_name");
    assert.deepEqual(out.context, {}, "cancel must not keep half-entered details");
  });
});

describe("nobody gets stuck in a loop", () => {
  it("offers a way out after three wrong answers", () => {
    let ctx: Context = {};
    let last: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = go("onboarding:email", ctx, "not-an-email");
      ctx = out.context;
      last = out.replies;
    }
    assert.equal(ctx.attempts, 3);
    assert.ok(
      last.some((r) => /hello@balans\.ng/.test(r)),
      "a third failure should offer a person to talk to",
    );
  });

  it("resets the counter once the step is passed", () => {
    const bad = go("onboarding:email", {}, "nope");
    const good = go("onboarding:email", bad.context, "kemi@studio.ng");
    assert.equal(good.context.attempts, 0);
  });
});

describe("the email step", () => {
  it("asks for another code on 'resend', and says so", () => {
    const out = go("onboarding:verify_email", { email: "a@b.ng" }, "resend");
    assert.equal(out.next, "onboarding:verify_email");
    assert.equal(out.effects[0]?.type, "send_email_code");
    // The effect is silent when it succeeds, so without a reply here a resend
    // answers with nothing at all.
    assert.match(out.replies[0]!, /a@b\.ng/);
  });

  it("goes back a step on 'change'", () => {
    const out = go("onboarding:verify_email", { email: "typo@b.ng" }, "change");
    assert.equal(out.next, "onboarding:email");
    assert.equal(out.context.email, undefined, "the bad address must not linger");
  });

  it("accepts a code with spaces in it", () => {
    const out = go("onboarding:verify_email", { email: "a@b.ng" }, "123 456");
    const effect = out.effects[0];
    assert.equal(effect?.type, "verify_email_code");
    assert.equal(effect.type === "verify_email_code" && effect.code, "123456");
  });

  it("rejects a five-digit code without calling the checker", () => {
    const out = go("onboarding:verify_email", { email: "a@b.ng" }, "12345");
    assert.equal(out.effects.length, 0);
    assert.equal(out.next, "onboarding:verify_email");
  });
});

describe("what setup costs to run", () => {
  // WhatsApp bills Nigeria per service message from 1 October 2026, and PRD
  // section 15 puts the whole of setup at six bot messages. Every extra bubble
  // is real money on a plan that earns a minimum of N100 on a paid invoice, so
  // the budget is a test rather than an intention.
  const BUDGET = 6;

  it(`the happy path sends at most ${BUDGET} messages`, () => {
    const { replies, acks } = walk([
      "Hi",
      "Kemi Adeyemi Studio",
      "GTBank 0123456789",
      "kemi@studio.ng",
      "123456",
      "I agree",
    ]);
    // The confirm question comes from the caller, which knows the resolved
    // name; the machine cannot produce it, so it is counted here by hand.
    const total = replies.length + acks.length + 1;
    assert.ok(total <= BUDGET, `setup sends ${total} messages, budget is ${BUDGET}`);
  });

  it("answers every turn with exactly one message", () => {
    // Two bubbles for one answer is two charges and a worse read. Anything the
    // machine wants to say in the same breath belongs in the same message.
    const turns: [State, Context, string][] = [
      ["new", {}, "Hi"],
      ["new", {}, "Invoice Tunde 20k"],
      ["onboarding:business_name", {}, "Kemi Adeyemi Studio"],
      ["onboarding:bank", { businessName: "X" }, "GTBank 0123456789"],
      ["onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "kemi@studio.ng"],
      ["onboarding:email", {}, "kemi@studio.ng"],
      ["onboarding:verify_email", { email: "a@b.ng" }, "123456"],
      ["onboarding:verify_email", { email: "a@b.ng" }, "resend"],
      ["onboarding:consent", {}, "I agree"],
      ["onboarding:bank", {}, "cancel"],
    ];
    for (const [state, ctx, text] of turns) {
      const out = go(state, ctx, text);
      const sent = out.replies.length + (out.ack?.length ?? 0);
      assert.ok(sent <= 1, `${state} + "${text}" sends ${sent} messages`);
    }

    // The document steps too: a summary and a question in separate bubbles is
    // two charges for one answer.
    const docTurns: [State, Context, string, Parsed | undefined][] = [
      ["idle", {}, "invoice Tunde 20k for logo", parse({})],
      ["idle", {}, "who owes me", parse({ intent: "debtors" })],
      ["idle", {}, "gibberish", parse({ intent: "unknown" })],
      ["awaiting_field:client_name", { doc: DOC }, "Tunde", undefined],
      ["awaiting_field:amount", { doc: DOC }, "20k", undefined],
      ["awaiting_field:due_date", { doc: PRICED }, "friday", undefined],
      ["awaiting_confirm", DRAFTED, "yes", parse({ intent: "confirm" })],
      ["awaiting_confirm", DRAFTED, "no", parse({ intent: "reject" })],
      ["awaiting_confirm", DRAFTED, "what", parse({ intent: "unknown" })],
    ];
    for (const [state, ctx, text, parsed] of docTurns) {
      const out = doc(state, ctx, text, { parsed });
      const sent = out.replies.length + (out.ack?.length ?? 0);
      assert.ok(sent <= 1, `${state} + "${text}" sends ${sent} messages`);
    }
  });

  it("never leaves a turn with nothing to show for it", () => {
    // Except where an effect owns the answer: the code check and the bank
    // lookup both reply from the caller, which is the only thing that knows,
    // and a Flow's words travel on the form message itself.
    const effectOwned = ["resolve_account", "verify_email_code", "send_flow"];
    const turns: [State, Context, string][] = [
      ["new", {}, "Hi"],
      ["onboarding:business_name", {}, "Kemi Adeyemi Studio"],
      ["onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "kemi@studio.ng"],
      ["onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "yes"],
      ["onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "no"],
      ["onboarding:email", {}, "kemi@studio.ng"],
      ["onboarding:verify_email", { email: "a@b.ng" }, "resend"],
      ["onboarding:verify_email", { email: "a@b.ng" }, "change"],
      ["onboarding:consent", {}, "I agree"],
    ];
    for (const [state, ctx, text] of turns) {
      const out = go(state, ctx, text);
      if (out.effects.some((e) => effectOwned.includes(e.type))) continue;
      assert.ok(
        out.replies.length + (out.ack?.length ?? 0) > 0,
        `${state} + "${text}" answers with silence`,
      );
    }
  });
});

describe("how the messages read", () => {
  const rendered = Object.values(VOICE).map((v) => (typeof v === "function" ? v("kemi@studio.ng") : v));

  // The prose. Button sets live in VOICE too and are audited below against
  // their own rules, which are Meta's, not the design system's.
  const every = rendered.filter((v): v is string => typeof v === "string");
  const buttonSets = rendered.filter((v): v is { id: string; title: string }[] => Array.isArray(v));

  it("bolds something in every message", () => {
    // A message with no emphasis gives the eye nothing to land on, which is
    // the whole point of the exercise.
    for (const m of every) assert.match(m, /\*[^*]+\*/, `nothing bold in: ${m}`);
  });

  it("uses WhatsApp's markup, not Markdown's", () => {
    // ** is bold in Markdown and a literal pair of asterisks in WhatsApp.
    for (const m of every) assert.ok(!m.includes("**"), `Markdown bold in: ${m}`);
  });

  it("never bolds a whole paragraph", () => {
    // Bold marks values and actions. A bold explanation emphasises nothing.
    for (const m of every) {
      for (const span of m.match(/\*([^*\n]+)\*/g) ?? []) {
        assert.ok(span.length <= 60, `bold span too long: ${span}`);
      }
    }
  });

  it("uses at most one emoji, at the very start", () => {
    // A tick on every line is the same failure as bold on every line: a thread
    // of fifteen messages should be scannable, and that only works if the few
    // that carry a mark are the ones that matter.
    const EMOJI = /\p{Extended_Pictographic}/gu;
    const firstLine = (m: string) => m.split("\n")[0];
    for (const m of every) {
      const found = m.match(EMOJI) ?? [];
      assert.ok(found.length <= 1, `${found.length} emoji in: ${firstLine(m)}`);
      if (found.length === 1) {
        assert.ok(
          m.startsWith(found[0]!),
          `an emoji must lead the message, not hide in it: ${firstLine(m)}`,
        );
      }
    }
  });

  it("keeps button titles inside Meta's limit", () => {
    // Twenty characters. Meta does not truncate a longer title, it rejects the
    // whole message — so an over-long one takes the words with it and the
    // person is answered with silence.
    for (const set of buttonSets) {
      assert.ok(set.length >= 1 && set.length <= 3, `a message may carry 1-3 buttons, not ${set.length}`);
      const ids = new Set(set.map((btn) => btn.id));
      assert.equal(ids.size, set.length, "button ids must differ or the reply is ambiguous");

      for (const btn of set) {
        assert.ok(
          [...btn.title].length <= 20,
          `button title over 20 characters: ${btn.title}`,
        );
        assert.ok(btn.id.trim().length > 0, "a button id is what comes back when tapped");
      }
    }
  });

  it("closes every marker it opens", () => {
    for (const m of every) {
      for (const [mark, name] of [["*", "bold"], ["_", "italic"]] as const) {
        const count = m.split(mark).length - 1;
        assert.equal(count % 2, 0, `unclosed ${name} in: ${m}`);
      }
    }
  });
});

describe("confirming the account", () => {
  it("an email address is the confirmation, and saves a turn", () => {
    const out = go("onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "kemi@studio.ng");
    assert.equal(out.next, "onboarding:verify_email");
    assert.equal(out.context.email, "kemi@studio.ng");
    assert.deepEqual(
      out.effects.map((e) => e.type),
      ["create_subaccount", "send_email_code"],
      "the account must be set up before the code goes out",
    );
  });

  it("yes still works, and asks for the address on its own", () => {
    const out = go("onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "yes");
    assert.equal(out.next, "onboarding:email");
    assert.equal(out.effects[0]?.type, "create_subaccount");
  });

  it("no goes back and forgets the details", () => {
    const out = go(
      "onboarding:confirm_account",
      { accountNumber: "0123456789", bankName: "GTBank", resolvedAccountName: "SOMEONE ELSE" },
      "no",
    );
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.context.accountNumber, undefined);
    assert.equal(out.context.resolvedAccountName, undefined);
  });

  it("anything else asks again", () => {
    const out = go("onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "maybe");
    assert.equal(out.next, "onboarding:confirm_account");
    assert.match(out.replies[0]!, /KEMI A/);
  });

  it("does not read a wrong answer as an address", () => {
    const out = go("onboarding:confirm_account", { resolvedAccountName: "KEMI A" }, "no");
    assert.equal(out.next, "onboarding:bank");
    assert.equal(out.context.email, undefined);
  });
});

describe("consent", () => {
  it("only finishes on a clear yes", () => {
    for (const yes of ["I agree", "agree", "yes", "I accept"]) {
      assert.equal(go("onboarding:consent", {}, yes).next, "idle", yes);
    }
  });

  it("does not finish on anything else", () => {
    for (const no of ["no", "what is this", "maybe later"]) {
      assert.equal(go("onboarding:consent", {}, no).next, "onboarding:consent", no);
    }
  });

  it("stamps the version that was accepted", () => {
    const out = go("onboarding:consent", {}, "I agree");
    const effect = out.effects[0];
    assert.equal(effect?.type, "record_consent");
    assert.equal(effect.type === "record_consent" && effect.version, V);
  });
});

describe("a paused account", () => {
  it("is told why, whatever it sends", () => {
    for (const text of ["hi", "invoice Tunde 20k", "help"]) {
      const out = go("paused", {}, text);
      assert.equal(out.next, "paused");
      assert.match(out.replies[0]!, /on hold|review/i);
    }
  });
});

describe("a first message that is not a greeting", () => {
  it("still starts setup, without scolding", () => {
    const out = go("new", {}, "Invoice Tunde 20k for logo design");
    assert.equal(out.next, "onboarding:form");

    const effect = out.effects[0];
    assert.equal(effect?.type, "send_flow");
    // The words ride on the form message, so that is where to look for them.
    assert.match(effect.type === "send_flow" ? effect.body : "", /set up first/i);
  });

  it("opens the setup form on a greeting too", () => {
    const out = go("new", {}, "Hi");
    assert.equal(out.next, "onboarding:form");
    const effect = out.effects[0];
    assert.equal(effect?.type, "send_flow");
    assert.equal(effect.type === "send_flow" ? effect.key : "", "onboarding");
  });

  it("keeps what they typed when they answer instead of filling the form", () => {
    // Someone who types their business name while the form is open has
    // already answered the first question. Asking it again would be rude.
    const out = go("onboarding:form", {}, "Kemi Adeyemi Studio");
    assert.equal(out.context.businessName, "Kemi Adeyemi Studio");
    assert.equal(out.next, "onboarding:bank");
  });

  it("asks the question when they only say hello", () => {
    const out = go("onboarding:form", {}, "hello");
    assert.equal(out.next, "onboarding:business_name");
    assert.match(out.replies.join(" "), /what is your business called/i);
  });
});

describe("business names", () => {
  it("collapses runs of whitespace", () => {
    const out = go("onboarding:business_name", {}, "  Kemi   Adeyemi   Studio  ");
    assert.equal(out.context.businessName, "Kemi Adeyemi Studio");
  });

  it("refuses a single character", () => {
    assert.equal(go("onboarding:business_name", {}, "K").next, "onboarding:business_name");
  });

  it("refuses something absurdly long", () => {
    assert.equal(
      go("onboarding:business_name", {}, "x".repeat(200)).next,
      "onboarding:business_name",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Draft and confirm (F6)                                                     */
/* -------------------------------------------------------------------------- */

/** Wednesday, 23 September 2026, matching the parser and date suites. */
const NOW: Civil = { y: 2026, m: 9, d: 23 };

/** A parse, with the fields a test cares about and sane defaults for the rest. */
function parse(over: Partial<Parsed>): Parsed {
  return {
    intent: "create_invoice",
    clientName: "Tunde",
    clientEmail: null,
    lineItems: [{ description: "logo design", qty: 1, unitAmountKobo: 20_000_00 }],
    totalKobo: 20_000_00,
    dueDate: null,
    dueDatePhrase: null,
    documentNumber: null,
    options: { depositPercent: null, passFeesToClient: null, vatPercent: null, notes: null },
    confidence: 0.95,
    source: "pattern",
    missing: [],
    ...over,
  };
}

const doc = (
  state: State,
  ctx: Context,
  text: string,
  extra: { parsed?: Parsed; correction?: Correction | null } = {},
) => step(state, ctx, { text, today: NOW, ...extra }, V);

/** A document with a name but no price yet. */
const DOC = { type: "invoice" as const, clientName: "Tunde", lines: [] };
const PRICED = {
  type: "invoice" as const,
  clientName: "Tunde",
  lines: [{ description: "logo", qty: 1, unitAmountKobo: 20_000_00 }],
};
const DRAFTED: Context = { doc: PRICED, draftId: "00000000-0000-0000-0000-000000000001" };

describe("a tapped button", () => {
  /*
   * A button's id arrives as the message text, which is why every id is a
   * phrase the machine already reads. These assert that a tap and a typed
   * reply take the same path, so the buttons never need a branch of their own.
   */

  it("sends the draft when Send it is tapped", () => {
    const out = doc("awaiting_confirm", DRAFTED, "yes", { parsed: parse({ intent: "confirm" }) });
    assert.equal(out.effects[0]?.type, "send_document");
  });

  it("discards the draft when Discard is tapped", () => {
    const out = doc("awaiting_confirm", DRAFTED, "no", { parsed: parse({ intent: "reject" }) });
    assert.equal(out.effects[0]?.type, "discard_draft");
  });

  it("asks what to change when Change it is tapped, and keeps the draft", () => {
    const out = doc("awaiting_confirm", DRAFTED, "change something", {
      parsed: parse({ intent: "unknown" }),
      correction: null,
    });
    assert.equal(out.next, "awaiting_confirm", "the draft is still on screen");
    assert.deepEqual(out.effects, [], "nothing is sent or thrown away");
    assert.match(out.replies.join(" "), /what should i change/i);
  });

  it("does not mistake a sentence about changing for the button", () => {
    // "change something" is matched whole. A correction that happens to use
    // the word belongs to the correction parser, not to the button branch.
    const out = doc("awaiting_confirm", DRAFTED, "change something about the amount, make it 40k", {
      parsed: parse({ intent: "unknown" }),
      correction: { totalKobo: 40_000_00 } as Correction,
    });
    assert.doesNotMatch(out.replies.join(" "), /what should i change/i);
  });

  it("finishes onboarding when I agree is tapped", () => {
    const out = doc("onboarding:consent", { email: "kemi@studio.ng" }, "I agree");
    assert.equal(out.effects[0]?.type, "record_consent");
  });

  it("offers the same two taps again when the code step is retried", () => {
    const out = doc("onboarding:verify_email", { email: "kemi@studio.ng" }, "resend");
    assert.equal(out.effects[0]?.type, "send_email_code");
    assert.deepEqual(
      out.buttons?.map((btn) => btn.id),
      ["resend", "change"],
      "a code that never arrives twice still needs a way out",
    );
  });
});

describe("a message becomes a draft", () => {
  it("goes straight to the confirm step when nothing is missing", () => {
    const out = doc("idle", {}, "invoice Tunde 20k for logo", { parsed: parse({}) });
    assert.equal(out.next, "awaiting_confirm");
    assert.equal(out.effects[0]?.type, "save_draft");
    // The summary comes from the saved row, so the machine says nothing here.
    assert.deepEqual(out.replies, []);
  });

  it("fills in the due date the user did not give", () => {
    // F6: seven days from issue, configurable in settings.
    const out = doc("idle", {}, "invoice Tunde 20k for logo", { parsed: parse({}) });
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.deepEqual(
      effect.type === "save_draft" ? effect.doc.dueDate : null,
      { y: 2026, m: 9, d: 30 },
    );
  });

  it("gives a quote fourteen days to live, not seven", () => {
    // F5: quotes are valid for 14 days by default. They do not fall due.
    const out = doc("idle", {}, "quote Tunde 20k for logo", {
      parsed: parse({ intent: "create_quote" }),
    });
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.deepEqual(
      effect.type === "save_draft" ? effect.doc.dueDate : null,
      { y: 2026, m: 10, d: 7 },
    );
  });

  it("calls it Services when the work was not described", () => {
    const out = doc("idle", {}, "invoice Tunde 20k", {
      parsed: parse({ lineItems: [], totalKobo: 20_000_00 }),
    });
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.equal(
      effect.type === "save_draft" ? effect.doc.lines[0]?.description : null,
      "Services",
    );
  });
});

describe("asking for the one thing that is missing", () => {
  it("asks who it is for, and nothing else", () => {
    const out = doc("idle", {}, "invoice 20k for logo", {
      parsed: parse({ clientName: null, missing: ["client_name"] }),
    });
    assert.equal(out.next, "awaiting_field:client_name");
    assert.equal(out.effects.length, 0, "nothing is written until it is complete");
    assert.match(out.replies[0]!, /who is this for/i);
    assert.doesNotMatch(out.replies[0]!, /how much/i, "one question at a time");
  });

  it("asks how much, naming the client so it reads like a conversation", () => {
    const out = doc("idle", {}, "invoice Tunde for logo", {
      parsed: parse({ totalKobo: null, lineItems: [], missing: ["amount"] }),
    });
    assert.equal(out.next, "awaiting_field:amount");
    assert.match(out.replies[0]!, /Tunde/);
  });

  it("takes the answer and drafts", () => {
    const out = doc("awaiting_field:amount", { doc: DOC }, "350k");
    assert.equal(out.next, "awaiting_confirm");
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.equal(
      effect.type === "save_draft" ? effect.doc.lines[0]?.unitAmountKobo : null,
      350_000_00,
    );
  });

  it("prices the work already named rather than adding a second line", () => {
    const named = { type: "invoice" as const, clientName: "Tunde",
      lines: [{ description: "photoshoot", qty: 1, unitAmountKobo: 0 }] };
    const out = doc("awaiting_field:amount", { doc: named }, "350k");
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    if (effect.type !== "save_draft") return;
    assert.equal(effect.doc.lines.length, 1);
    assert.equal(effect.doc.lines[0]!.description, "photoshoot");
    assert.equal(effect.doc.lines[0]!.unitAmountKobo, 350_000_00);
  });

  it("asks again rather than accepting an amount it cannot read", () => {
    const out = doc("awaiting_field:amount", { doc: DOC }, "plenty");
    assert.equal(out.next, "awaiting_field:amount");
    assert.equal(out.effects.length, 0);
  });

  it("asks about a date it was given but could not read", () => {
    const out = doc("idle", {}, "invoice Tunde 20k for logo due whenever", {
      parsed: parse({ dueDatePhrase: "whenever", dueDate: null }),
    });
    assert.equal(out.next, "awaiting_field:due_date");
  });

  it("does not ask about a date nobody mentioned", () => {
    const out = doc("idle", {}, "invoice Tunde 20k for logo", { parsed: parse({}) });
    assert.equal(out.next, "awaiting_confirm");
  });

  it("lets someone skip the date and take the default", () => {
    const out = doc("awaiting_field:due_date", { doc: PRICED }, "skip");
    assert.equal(out.next, "awaiting_confirm");
  });
});

describe("the draft on screen", () => {
  it("sends on a yes", () => {
    const out = doc("awaiting_confirm", DRAFTED, "yes", { parsed: parse({ intent: "confirm" }) });
    assert.equal(out.next, "idle");
    assert.equal(out.effects[0]?.type, "send_document");
  });

  it("is dropped on a no, and forgotten", () => {
    const out = doc("awaiting_confirm", DRAFTED, "no", { parsed: parse({ intent: "reject" }) });
    assert.equal(out.next, "idle");
    assert.equal(out.effects[0]?.type, "discard_draft");
    assert.equal(out.context.draftId, undefined, "a dropped draft must not linger");
    assert.equal(out.context.doc, undefined);
  });

  it("takes a correction and shows it again", () => {
    const out = doc("awaiting_confirm", DRAFTED, "make it 400k", {
      parsed: parse({ intent: "unknown" }),
      correction: { totalKobo: 400_000_00 },
    });
    assert.equal(out.next, "awaiting_confirm");
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.equal(
      effect.type === "save_draft" ? effect.doc.lines[0]?.unitAmountKobo : null,
      400_000_00,
    );
  });

  it("keeps the description when only the amount changes", () => {
    const out = doc("awaiting_confirm", DRAFTED, "make it 400k", {
      correction: { totalKobo: 400_000_00 },
    });
    const effect = out.effects[0];
    assert.equal(
      effect?.type === "save_draft" ? effect.doc.lines[0]?.description : null,
      "logo",
    );
  });

  it("takes a new date without touching the money", () => {
    const out = doc("awaiting_confirm", DRAFTED, "due next friday", {
      correction: { dueDate: { y: 2026, m: 10, d: 2 }, duePhrase: "next friday" },
    });
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    if (effect.type !== "save_draft") return;
    assert.deepEqual(effect.doc.dueDate, { y: 2026, m: 10, d: 2 });
    assert.equal(effect.doc.lines[0]!.unitAmountKobo, 20_000_00);
  });

  it("is replaced outright by a new document", () => {
    const out = doc("awaiting_confirm", DRAFTED, "invoice Kemi 50k for shoot", {
      parsed: parse({ clientName: "Kemi", lineItems: [{ description: "shoot", qty: 1, unitAmountKobo: 50_000_00 }] }),
    });
    assert.equal(out.next, "awaiting_confirm");
    const effect = out.effects[0];
    assert.equal(effect?.type, "save_draft");
    assert.equal(effect.type === "save_draft" ? effect.doc.clientName : null, "Kemi");
  });

  it("asks again when it cannot tell what was meant", () => {
    const out = doc("awaiting_confirm", DRAFTED, "hmm", { parsed: parse({ intent: "unknown" }) });
    assert.equal(out.next, "awaiting_confirm", "the draft must survive a confused reply");
    assert.match(out.replies[0]!, /yes|no/i);
  });
});

describe("a new command still wins (section 5)", () => {
  // "A new command always wins over a pending question, so users are never
  // trapped." A draft on screen is the strongest pending question there is.
  const commands: [string, Parsed["intent"]][] = [
    ["who owes me", "debtors"],
    ["summary", "summary"],
    ["settings", "settings"],
    ["upgrade", "upgrade"],
    ["cancel invoice 3", "cancel_document"],
  ];

  for (const [text, intent] of commands) {
    it(`${JSON.stringify(text)} escapes the confirm step`, () => {
      const out = doc("awaiting_confirm", DRAFTED, text, { parsed: parse({ intent }) });
      // Settings opens its own menu; everything else lands back at idle. Both
      // are an escape — what matters is that the draft did not survive.
      assert.notEqual(out.next, "awaiting_confirm");
      assert.equal(out.effects[0]?.type, "discard_draft", "the draft goes with it");
      assert.equal(out.context.draftId, undefined);
    });

    it(`${JSON.stringify(text)} escapes a pending question`, () => {
      const out = doc("awaiting_field:amount", { doc: DOC }, text, { parsed: parse({ intent }) });
      assert.notEqual(out.next, "awaiting_field:amount");
    });
  }

  it("help works with a draft on screen, without dropping it", () => {
    const out = doc("awaiting_field:amount", { doc: DOC }, "help");
    assert.equal(out.next, "awaiting_field:amount", "asking for help must not cost the draft");
  });
});

describe("nothing is drafted out of nothing", () => {
  it("a stray yes with no draft says so", () => {
    const out = doc("idle", {}, "yes", { parsed: parse({ intent: "confirm" }) });
    assert.equal(out.next, "idle");
    assert.equal(out.effects.length, 0);
    assert.match(out.replies[0]!, /no draft/i);
  });

  it("a confirm step with no draft in hand recovers rather than throwing", () => {
    const out = doc("awaiting_confirm", {}, "yes", { parsed: parse({ intent: "confirm" }) });
    assert.equal(out.next, "idle");
    assert.equal(out.effects.length, 0);
  });

  it("a pending field with no document recovers too", () => {
    const out = doc("awaiting_field:amount", {}, "20k");
    assert.equal(out.next, "idle");
  });

  it("says plainly when nothing could read the message", () => {
    const out = step("idle", {}, { text: "...", today: NOW, parseFailed: "unavailable" }, V);
    assert.equal(out.next, "idle");
    assert.equal(out.effects.length, 0);
    assert.match(out.replies[0]!, /could not read/i);
  });

  it("refuses a message that is too long, in its own words", () => {
    const out = step("idle", {}, { text: "x", today: NOW, parseFailed: "too_long" }, V);
    assert.match(out.replies[0]!, /too long/i);
  });

  it("never emits save_draft without a client and an amount", () => {
    const bad: [Partial<Parsed>, string][] = [
      [{ clientName: null, missing: ["client_name"] }, "no client"],
      [{ totalKobo: null, lineItems: [], missing: ["amount"] }, "no amount"],
      [{ clientName: null, totalKobo: null, lineItems: [] }, "neither"],
    ];
    for (const [over, why] of bad) {
      const out = doc("idle", {}, "something", { parsed: parse(over) });
      assert.ok(
        !out.effects.some((e) => e.type === "save_draft"),
        `drafted with ${why}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Settings (F17)                                                             */
/* -------------------------------------------------------------------------- */

describe("the settings menu", () => {
  /**
   * Each row of the tappable list, by the id it sends back.
   *
   * These ids are phrases the parser also understands as "open settings",
   * which is the trap: read in that order, tapping a row reopens the menu and
   * the person taps forever. Kept here as the ids the list actually uses, so
   * changing one without changing the other fails.
   */
  const rows: [string, State][] = [
    ["change business name", "settings:business_name"],
    ["change bank", "settings:bank_code"],
    ["due days", "settings:due_days"],
    ["delete my account", "settings:delete_confirm"],
  ];

  for (const [id, next] of rows) {
    it(`tapping ${JSON.stringify(id)} goes to ${next}`, () => {
      // With `parsed` set, because the handler now supplies one from the free
      // command matcher even in states that do not call the model.
      const out = doc("settings:menu", {}, id, { parsed: parse({ intent: "settings" }) });
      assert.equal(out.next, next, `${id} did not advance`);
      assert.notEqual(out.next, "settings:menu", "the menu reopened itself");
    });
  }

  it("does not reopen itself when the row is also a settings phrase", () => {
    // The specific loop: "change bank" reads as both a row and a command.
    const out = doc("settings:menu", {}, "change bank", { parsed: parse({ intent: "settings" }) });
    assert.ok(
      !out.effects.some((e) => e.type === "show_settings"),
      "tapping a row must not show the menu again",
    );
  });

  it("still lets a genuinely different command win (section 5)", () => {
    for (const intent of ["debtors", "summary", "upgrade"] as const) {
      const out = doc("settings:menu", {}, "who owes me", { parsed: parse({ intent }) });
      assert.notEqual(out.next, "settings:menu", `${intent} did not escape settings`);
    }
  });

  it("opens the design picker from its row, and from its number", () => {
    for (const said of ["invoice design", "design", "4"]) {
      const out = doc("settings:menu", {}, said, { parsed: parse({ intent: "templates" }) });
      assert.ok(
        out.effects.some((e) => e.type === "show_designs"),
        `${JSON.stringify(said)} did not open the picker`,
      );
      assert.equal(out.next, "idle", "the picker is a link, not another question");
    }
  });

  it("keeps the numbers in step with the rows they are printed beside", () => {
    // The design row was inserted above "close my account", which moved that
    // one from 4 to 5. A number that opens the wrong row closes an account.
    const four = doc("settings:menu", {}, "4", { parsed: parse({ intent: "templates" }) });
    assert.notEqual(four.next, "settings:delete_confirm", "4 must no longer start a deletion");

    const five = doc("settings:menu", {}, "5", { parsed: parse({ intent: "unknown" }) });
    assert.equal(five.next, "settings:delete_confirm");
  });

  it("closes on cancel", () => {
    const out = doc("settings:menu", {}, "cancel", { parsed: parse({ intent: "reject" }) });
    assert.equal(out.next, "idle");
  });

  it("asks again when the answer is not on the menu", () => {
    const out = doc("settings:menu", {}, "purple", { parsed: parse({ intent: "unknown" }) });
    assert.equal(out.next, "settings:menu");
  });
});

/*
 * The loop a real user hit: they confirmed a bank change, the effect behind it
 * threw on a database constraint, and because a throw produced no reply and
 * saved no state, every later message met the same question again. Typing a
 * command did not get them out either.
 *
 * The throw is fixed elsewhere. These are the conversational halves: a yes
 * must commit, and anything that is plainly a different instruction must be
 * able to leave.
 */
describe("confirming a new bank account (F17)", () => {
  const changing = {
    bankCode: "044",
    bankName: "Access bank",
    accountNumber: "1960725673",
    accountName: "DANIEL INIOBONG UWAK",
    subAccountCode: "MFY_SUB_1",
  };
  const at = (text: string, parsed?: Parsed) =>
    doc("settings:bank_confirm", { changing }, text, parsed ? { parsed } : {});

  for (const yes of ["yes", "Yes", "yep", "correct", "ok", "confirm"]) {
    it(`commits on ${JSON.stringify(yes)}`, () => {
      const out = at(yes, parse({ intent: "confirm" }));
      assert.ok(
        out.effects.some((e) => e.type === "commit_bank_change"),
        "the change was not committed",
      );
      assert.equal(out.next, "idle");
    });
  }

  for (const no of ["no", "nope", "wrong", "cancel"]) {
    it(`abandons on ${JSON.stringify(no)}`, () => {
      const out = at(no, parse({ intent: "reject" }));
      assert.ok(out.effects.some((e) => e.type === "cancel_bank_change"));
      assert.equal(out.next, "idle");
    });
  }

  it("asks again when the answer is neither, and says which account", () => {
    const out = at("maybe later", parse({ intent: "unknown" }));
    assert.equal(out.next, "settings:bank_confirm");
    assert.match(out.replies.join("\n"), /DANIEL INIOBONG UWAK/);
  });

  /*
   * The half that was missing. "/design" is not yes, not no, and not an
   * answer to this question at all — so it must take them somewhere, not
   * repeat the question a third time.
   */
  it("lets a command out, rather than repeating the question", () => {
    const out = at("/design", parse({ intent: "templates" }));
    assert.notEqual(out.next, "settings:bank_confirm", "still stuck on the question");
    assert.ok(
      out.effects.some((e) => e.type === "show_designs"),
      "the command did not run",
    );
  });

  it("does not leave a half-answered change behind when a command wins", () => {
    const out = at("who owes me", parse({ intent: "debtors" }));
    assert.equal(out.context.changing, undefined, "the abandoned change is still in context");
    assert.ok(out.effects.some((e) => e.type === "show_debtors"));
  });

  /*
   * "no" is both an answer here and a global cancel. The question has to win,
   * or answering it honestly would escape instead of declining.
   */
  it("reads no as declining the change, not as a cancel command", () => {
    const out = at("no", parse({ intent: "reject" }));
    assert.ok(out.effects.some((e) => e.type === "cancel_bank_change"));
  });
});


/*
 * From a real thread: "/quote" put a quote form on screen, and "/invoice"
 * sent next was read as the answer to "who is this for?". The client became
 * "/invoice" and the bot asked how much /invoice was paying.
 */
describe("asking for a different document mid-flow", () => {
  const halfBuilt = { doc: { type: "quote" as const, lines: [] } };

  /** What `asCommand("/invoice")` actually produces: an intent and nothing else. */
  const bare = (intent: Parsed["intent"]): Parsed =>
    parse({
      intent,
      source: "command",
      clientName: null,
      lineItems: [],
      totalKobo: null,
      confidence: 1,
      missing: ["client_name", "amount", "description"],
    });

  for (const [command, intent, wanted] of [
    ["/invoice", "create_invoice", "invoice"],
    ["/quote", "create_quote", "quote"],
    ["/collect", "payment_request", "payment_request"],
  ] as const) {
    it(`${command} while a client name is being asked for starts a ${wanted}`, () => {
      const out = doc("awaiting_field:client_name", halfBuilt, command, {
        parsed: bare(intent),
      });

      assert.equal(out.context.doc?.type, wanted, "it kept the old document");
      assert.notEqual(out.context.doc?.clientName, command, "the command became the client");
      assert.match(out.replies.join("\n"), /Copy this|Who is this for/i);
    });
  }

  it("does not carry the abandoned document forward", () => {
    const out = doc(
      "awaiting_field:amount",
      { doc: { type: "quote", clientName: "Zenith Homes", lines: [] } },
      "/invoice",
      { parsed: bare("create_invoice") },
    );
    assert.equal(out.context.doc?.type, "invoice");
    assert.equal(out.context.doc?.clientName, undefined, "the old client survived the restart");
  });

  /*
   * The other half. The parser reads plenty of plain answers as document
   * intents, and restarting on those would throw away the answer somebody
   * just gave — so only an exact command counts.
   */
  it("still takes a plain name as a name, however the model reads it", () => {
    const out = doc("awaiting_field:client_name", halfBuilt, "Zenith Homes", {
      parsed: parse({ intent: "create_invoice", clientName: "Zenith Homes" }),
    });
    assert.equal(out.context.doc?.clientName, "Zenith Homes");
  });

  it("refuses a slash command as a client name whatever the parse says", () => {
    // The fallback path, for a command the matcher does not know.
    const out = doc("awaiting_field:client_name", halfBuilt, "/whatever", {
      parsed: parse({ intent: "unknown" }),
    });
    assert.equal(out.next, "awaiting_field:client_name");
    assert.notEqual(out.context.doc?.clientName, "/whatever");
  });
});
