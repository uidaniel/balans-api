import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { step, type Context, type State } from "./machine.ts";

const V = "2026-09-draft-1";
const go = (state: State, ctx: Context, text: string) => step(state, ctx, { text }, V);

/** Walks the whole flow, returning every state it passed through. */
function walk(inputs: string[]): { states: State[]; ctx: Context; replies: string[] } {
  let state: State = "new";
  let ctx: Context = {};
  const states: State[] = [];
  const replies: string[] = [];
  for (const text of inputs) {
    const out = go(state, ctx, text);
    state = out.next;
    ctx = out.context;
    states.push(state);
    replies.push(...out.replies);
  }
  return { states, ctx, replies };
}

describe("onboarding: the happy path", () => {
  const { states, ctx } = walk([
    "Hi",
    "Kemi Adeyemi Studio",
    "GTBank 0123456789",
    "yes",
    "kemi@studio.ng",
    "123456",
    "I agree",
  ]);

  it("ends idle, set up", () => assert.equal(states.at(-1), "idle"));
  it("visits each step once, in order", () => {
    assert.deepEqual(states, [
      "onboarding:business_name",
      "onboarding:bank",
      "onboarding:confirm_account",
      "onboarding:email",
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
  it("asks for another code on 'resend'", () => {
    const out = go("onboarding:verify_email", { email: "a@b.ng" }, "resend");
    assert.equal(out.next, "onboarding:verify_email");
    assert.equal(out.effects[0]?.type, "send_email_code");
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

describe("nothing waits in silence", () => {
  // Anything that reaches a bank or a mailbox takes a second or two, and a
  // silent gap in a chat reads as nothing happening.
  it("says it is checking before it checks the account", () => {
    const out = go("onboarding:bank", { businessName: "X" }, "GTBank 0123456789");
    assert.ok(out.ack?.length, "the bank lookup must announce itself first");
    assert.match(out.ack![0]!, /moment|checking/i);
    // And not as a reply, which would arrive after the answer it precedes.
    assert.equal(out.replies.length, 0);
  });

  it("says it is checking before it checks the code", () => {
    const out = go("onboarding:verify_email", { email: "a@b.ng" }, "123456");
    assert.ok(out.ack?.length, "the code check must announce itself first");
    assert.match(out.ack![0]!, /checking/i);
  });

  it("never puts a slow step's reassurance in replies", () => {
    // replies are sent after the effects, so a "one moment" there arrives at
    // the same time as the result it was meant to precede.
    for (const [state, ctx, text] of [
      ["onboarding:bank", { businessName: "X" }, "GTBank 0123456789"],
      ["onboarding:verify_email", { email: "a@b.ng" }, "123456"],
    ] as const) {
      const out = go(state, ctx, text);
      for (const r of out.replies) {
        assert.ok(!/one moment|checking/i.test(r), `"${r}" belongs in ack, not replies`);
      }
    }
  });
});

describe("confirming the account", () => {
  it("yes moves on and asks for a subaccount", () => {
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
    assert.equal(out.next, "onboarding:business_name");
    assert.ok(out.replies.some((r) => /set up first/i.test(r)));
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
