/**
 * The first message, from somebody who has never used this.
 *
 * WhatsApp shows four tappable suggestions above an *empty* chat, so every
 * one of them is read by a stranger and arrives as an ordinary message with
 * that exact text. Two of the old four — "Who owes me?" and "How did I do
 * this month?" — answered with nothing at all, because there are no debtors
 * and no month behind somebody who has not signed up.
 *
 * These tests are driven from `PROMPTS` itself rather than from copies of
 * the strings, so a suggestion cannot be reworded into one that nothing
 * recognises. That is the failure this file exists to prevent: an ice
 * breaker is a promise the product makes before anybody has typed a word.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step, VOICE } from "./machine.ts";
import type { Context, State } from "./machine.ts";
import { asCommand, faqKind } from "../parser/commands.ts";
import { PROMPTS } from "../whatsapp/register-commands.ts";
import type { Parsed } from "../parser/schema.ts";

const V = "2026-09-draft-1";
const TODAY = { y: 2026, m: 9, d: 23 };

/** What the free command reader hands the machine, as handle.ts does it. */
const parsedFor = (text: string): Parsed | undefined => {
  const c = asCommand(text);
  if (!c) return undefined;
  return {
    intent: c.intent,
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
    money: { kind: "naira" },
    source: "command",
    missing: [],
  } as Parsed;
};

const say = (state: State, text: string, context: Context = {}) =>
  step(state, context, { text, today: TODAY, parsed: parsedFor(text) }, V);

/** The body of the message that carries the setup form. */
const flowBody = (out: ReturnType<typeof say>): string => {
  const flow = out.effects.find((e) => e.type === "send_flow");
  assert.ok(flow, "the setup form should be offered");
  return flow.body ?? "";
};

/*
 * The ice breaker is "Get Started" alone now. The other three were retired
 * from above the chat, but they are still what strangers type, so they are
 * kept here as things a first message says.
 */
const [GET_STARTED = ""] = PROMPTS;
const SET_ME_UP = "Set me up";
const EXAMPLE = "Invoice Tunde 20k for logo design, due Friday";
const HOW = "How does Balans work?";
const SAFE = "Is my money safe?";

describe("the thing offered above an empty chat", () => {
  it("is one button, Get Started", () => {
    // One invitation, not a menu to study before saying anything.
    assert.deepEqual(PROMPTS, ["Get Started"]);
    for (const p of PROMPTS) assert.ok(p.length <= 80, `${p} is ${p.length} characters`);
  });

  it("answers Get Started exactly as it answers hello", () => {
    assert.equal(flowBody(say("new", GET_STARTED)), VOICE.setupInvite);
    assert.equal(flowBody(say("new", GET_STARTED)), flowBody(say("new", "hi")));
    // And it is not an instruction to replay after setup.
    assert.equal(say("new", GET_STARTED).context.opener, undefined);
  });

  it("carries no emoji, because Meta will not keep one", () => {
    /*
     * "👋 Set me up" was written as correct UTF-8 and came back from Meta as
     * "\ufffd Set me up" — the replacement character. Two emoji from the
     * basic plane fared no better, so this is not about astral characters:
     * ice breakers hold plain text.
     *
     * It matters more here than anywhere else in the product. This is the
     * first thing a stranger sees, and a black diamond with a question mark
     * in it is the whole first impression.
     */
    for (const p of PROMPTS) {
      assert.doesNotMatch(p, /\p{Extended_Pictographic}|\uFFFD/u, `${p} will arrive broken`);
    }
  });

  it("offers nothing that answers with nothing", () => {
    /*
     * The bug this replaced. A stranger tapping "Who owes me?" is told they
     * are owed nothing — true, useless, and one of four slots spent proving
     * the product is empty.
     */
    for (const p of PROMPTS) {
      const intent = asCommand(p)?.intent;
      assert.ok(
        intent !== "debtors" && intent !== "summary" && intent !== "status",
        `${JSON.stringify(p)} asks for records a new user cannot have`,
      );
    }
  });

  it("recognises every one of them, including the emoji", () => {
    // Each arrives verbatim, emoji and all.
    assert.equal(faqKind(HOW), "how");
    assert.equal(faqKind(SAFE), "safety");

    // "Set me up" is not a command: it means "begin", which is what a first
    // message does anyway. What matters is that it is never read as an answer.
    assert.equal(flowBody(say("new", SET_ME_UP)), VOICE.setupInvite);

    // And the example is an instruction, which is the one kind that is kept.
    assert.equal(say("new", EXAMPLE).context.opener, EXAMPLE);
  });
});

describe("a stranger's first message", () => {
  it("never answers with the command menu", () => {
    /*
     * Ten slash commands, nine of which need the account that does not exist
     * yet. It is the worst answer in the product, and it was the one a new
     * number got for "help" and for "how does this work".
     */
    for (const text of [HOW, SAFE, "help", "what can you do"]) {
      const out = say("new", text);
      assert.ok(
        !out.effects.some((e) => e.type === "show_help"),
        `${JSON.stringify(text)} was answered with the menu`,
      );
      assert.ok(!flowBody(out).includes("/invoice"), "the menu leaked into the reply");
    }
  });

  it("explains the product in three steps, and leaves the button there", () => {
    const out = say("new", HOW);
    const body = flowBody(out);
    assert.ok(body.startsWith(VOICE.howItWorks), "the explanation is the answer");
    assert.match(body, /Tap below to set up/, "and the way to start is the same message");
    assert.equal(out.effects.find((e) => e.type === "send_flow")?.cta, "Set up Balans");
  });

  it("answers the money question with where the money goes", () => {
    const body = flowBody(say("new", SAFE));
    assert.match(body, /never holds your money/);
    assert.match(body, /your own bank account/, "it says where the money actually goes");
    assert.match(body, /your own bank account/);
  });

  it("treats a bare 'help' as the same question", () => {
    // From somebody with no account, "help" is "what is this", not "list the
    // commands I already know".
    assert.ok(flowBody(say("new", "help")).startsWith(VOICE.howItWorks));
  });
});

describe("the sentence somebody opened with", () => {
  it("is kept, word for word", () => {
    const out = say("new", EXAMPLE);
    assert.equal(out.context.opener, EXAMPLE);
    assert.equal(flowBody(out), VOICE.setupFirst, "and the reply promises to come back to it");
    assert.match(VOICE.setupFirst, /then I can do that/);
  });

  it("is not kept when there was no instruction in it", () => {
    /*
     * The ones answered where they were asked. Replaying any of these at the
     * end of setup is the bot repeating itself four minutes later.
     */
    for (const text of ["hi", "good morning", SET_ME_UP, HOW, SAFE, "help"]) {
      assert.equal(say("new", text).context.opener, undefined, `${text} was kept`);
    }
  });

  it("survives every step of setup, because it is only useful at the end", () => {
    // The typed path, one step at a time. Each of these rewrites the context,
    // and any one of them dropping it loses the draft.
    let ctx: Context = { opener: EXAMPLE };
    const steps: [State, string][] = [
      ["onboarding:form", "Kemi Adeyemi Studio"],
      ["onboarding:bank", "GTBank 0123456789"],
      ["onboarding:confirm_account", "kemi@studio.ng"],
      ["onboarding:verify_email", "123456"],
    ];
    for (const [state, text] of steps) {
      ctx = say(state, text, ctx).context;
      assert.equal(ctx.opener, EXAMPLE, `lost at ${state}`);
    }
  });

  it("is answered instead of the invoice card, once setup is done", () => {
    /*
     * The card invites them to create an invoice. Offering that to somebody
     * who asked for one before any of this started, and who has been filling
     * in a form ever since, is the bot admitting it was not listening.
     */
    const out = say("onboarding:consent", "I agree", { opener: EXAMPLE });
    assert.equal(out.next, "idle");
    assert.ok(
      !out.effects.some((e) => e.type === "send_flow"),
      "the generic invoice card was sent anyway",
    );
    assert.deepEqual(out.replies, [VOICE.doneNowThat]);
    assert.equal(out.context.opener, EXAMPLE, "the caller still needs it, to replay");
    assert.ok(out.effects.some((e) => e.type === "record_consent"), "consent is still recorded");
  });

  it("leaves the ordinary ending alone when there was no sentence", () => {
    const out = say("onboarding:consent", "I agree", {});
    const flow = out.effects.find((e) => e.type === "send_flow");
    assert.equal(flow?.key, "invoice");
    assert.equal(flow?.cta, "Create invoice");
  });
});

describe("the same questions, asked later", () => {
  it("does not let 'Set me up' become a business name", () => {
    /*
     * The suggestion stays tappable until something is sent, and tapping it
     * twice is what people do when a form does not open. At this step
     * anything that is not a greeting is the answer to "what is your business
     * called?" — so the name on every future invoice would have been
     * "👋 Set me up".
     */
    const out = say("onboarding:form", SET_ME_UP);
    assert.equal(out.context.businessName, undefined);
    assert.equal(out.next, "onboarding:form");
    assert.match(out.replies.join(" "), /just above/i);
  });

  it("answers the money question mid-setup, then repeats the step", () => {
    // Asked while being told to hand over a bank account, which is exactly
    // when it is asked. Re-asking for the bank without answering it is not
    // an answer to it.
    const out = say("onboarding:bank", SAFE);
    assert.equal(out.next, "onboarding:bank");
    assert.match(out.replies.join(" "), /never holds your money/);
    assert.match(out.replies.join(" "), /account number/i);
  });

  it("still answers it once somebody is set up", () => {
    // There is no command for where the money goes, so the menu cannot
    // answer this one however long they have been a user.
    const out = say("idle", SAFE);
    assert.deepEqual(out.replies, [VOICE.moneySafe]);
    assert.ok(!out.effects.some((e) => e.type === "show_help"));
  });

  it("still shows the menu to somebody who asks how it works", () => {
    // The opposite case, and why the two are not one branch: somebody with
    // an account asking "how does this work" wants the list of what they can
    // type, which is what the menu is.
    assert.ok(say("idle", "how does this work").effects.some((e) => e.type === "show_help"));
  });
});
