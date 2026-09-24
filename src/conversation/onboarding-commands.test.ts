/**
 * A command is not an answer to the question on screen.
 *
 * "/pro" was sent while setup was asking for a business name, and it was
 * saved as one — the account came out called "/pro". The whole of the check
 * was that a name is between two and eighty characters, and "/pro" is.
 *
 * Nothing behind those commands works during setup anyway: there is no bank
 * to be paid into, no plan to upgrade, nothing owed. So they are refused with
 * the question repeated, rather than swallowed as an answer to it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { step, VOICE } from "./machine.ts";
import type { State } from "./machine.ts";
import type { Parsed } from "../parser/schema.ts";

const V = "2026-09-draft-1";
const TODAY = { y: 2026, m: 9, d: 22 };

const say = (state: State, text: string, parsed?: Parsed) =>
  step(state, {}, { text, today: TODAY, parsed }, V);

/**
 * What the parser hands over for "/help".
 *
 * The machine's own HELP pattern knows "help" and "menu" but not "/help" —
 * the command reader knows that one, and handle.ts always parses before the
 * machine sees anything. Testing it without the parse would prove nothing
 * about either half.
 */
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
  money: { kind: "naira" },
  source: "command",
  missing: [],
};

const SETUP: State[] = [
  "onboarding:business_name",
  "onboarding:bank",
  "onboarding:confirm_account",
  "onboarding:email",
];

describe("slash commands during setup", () => {
  for (const state of SETUP) {
    it(`refuses one at ${state}`, () => {
      const out = say(state, "/pro");
      assert.equal(out.next, state, "it must not move the conversation on");
      assert.match(out.replies.join(" "), /once you are set up/i);
    });
  }

  it("repeats the question so nobody is stranded", () => {
    // Refusing without re-asking leaves somebody looking at a locked door
    // with no idea what was wanted.
    const out = say("onboarding:bank", "/owed");
    assert.match(out.replies.join(" "), /bank/i);
  });

  it("never takes one as a business name", () => {
    for (const text of ["/pro", "/invoice", "/settings", "/owed"]) {
      const out = say("onboarding:business_name", text);
      assert.equal(out.context.businessName, undefined, `${text} became a name`);
      assert.equal(out.next, "onboarding:business_name");
    }
  });

  it("still takes a real name", () => {
    const out = say("onboarding:business_name", "Danny Codes");
    assert.equal(out.context.businessName, "Danny Codes");
    assert.equal(out.next, "onboarding:bank");
  });

  it("takes a name that happens to be a command word", () => {
    /*
     * The reason only the slash form is refused.
     *
     * Somebody's business really could be called Pro, and at this exact
     * moment they are being asked for its name. The leading slash is the only
     * thing that separates a command from an answer, so it is the only thing
     * used to separate them.
     */
    for (const name of ["Pro", "Invoice", "Summary"]) {
      const out = say("onboarding:business_name", name);
      assert.equal(out.context.businessName, name, `${name} was refused`);
      assert.equal(out.next, "onboarding:bank");
    }
  });

  it("leaves help working, because that is about the question on screen", () => {
    const out = say("onboarding:business_name", "/help", helpParse);
    assert.doesNotMatch(out.replies.join(" "), /once you are set up/i);
    assert.match(out.replies.join(" "), /name/i);
    assert.notEqual(out.replies[0], VOICE.helpIdle, "not the whole menu, mid-setup");
  });

  it("leaves cancel working, so somebody can get out", () => {
    const out = say("onboarding:bank", "cancel");
    assert.ok(out.effects.some((e) => e.type === "send_flow"), "cancel should restart setup");
  });

  it("refuses one while the form is open, and says nothing else", () => {
    /*
     * The state this list forgot.
     *
     * `onboarding:form` had no case in `onboardingHelp`, so it fell through
     * to the default and the refusal arrived with the entire "What I can do"
     * menu stapled underneath it: nine commands listed, almost all of them
     * refused for the same reason as the one just tried. The caller's own
     * comment says the whole menu is the thing to avoid mid-setup.
     */
    const out = say("onboarding:form", "/pro");
    const said = out.replies.join(" ");

    assert.doesNotMatch(said, /What I can do/i, "the menu is back");

    // Equality, not a match. `para` joins its parts into one string, so
    // counting replies or grepping for the menu would both pass while
    // something else was still stapled underneath the refusal.
    assert.deepEqual(out.replies, [VOICE.setupBeforeCommands], "the refusal and nothing else");
    assert.equal(out.next, "onboarding:form", "and the form is still open");
  });

  it("does not list commands it is in the middle of refusing", () => {
    // Every one of these is refused at this point, so naming them is an
    // invitation to try eight more locked doors.
    const said = say("onboarding:form", "/pro").replies.join(" ");
    for (const cmd of ["/invoice", "/quote", "/collect", "/owed", "/summary", "/status", "/settings", "/design"]) {
      assert.ok(!said.includes(cmd), `${cmd} is offered to somebody who cannot use it`);
    }
  });

  it("still points somebody at the form when they ask for help", () => {
    // The other caller of the same branch. Help mid-form is about the form,
    // not about the commands that form unlocks.
    const said = say("onboarding:form", "/help", helpParse).replies.join(" ");

    assert.doesNotMatch(said, /once you are set up/i, "help is not a refusal");
    assert.doesNotMatch(said, /What I can do/i);
    assert.match(said, /Set up Balans/, "it names the button on screen");
    assert.match(said, /business name/i, "and the way to do it by hand");
  });

  it("does not interfere once setup is done", () => {
    // At idle the commands are the point of the product.
    const out = say("idle", "/pro");
    assert.doesNotMatch(out.replies.join(" "), /once you are set up/i);
  });
});

describe("what counts as a business name", () => {
  const nameFrom = (text: string) => say("onboarding:business_name", text).context.businessName;
  const refusal = (text: string) => say("onboarding:business_name", text).replies.join(" ");

  /*
   * The half that matters more.
   *
   * A wrong name that got through is fixed in /settings in ten seconds. A
   * right name that was refused is somebody who cannot finish signing up —
   * so every one of these has to pass, and the short, the accented and the
   * digit-leading ones are exactly where a "does this look like a business?"
   * check would go wrong.
   */
  for (const name of [
    "Kemi Adeyemi Studio",
    "Xo",
    "MOTX",
    "9ja Prints",
    "247 Logistics",
    "Studio 54",
    "Chukwuemeka",
    "D",  // too short on its own, but see below
  ].slice(0, -1)) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(nameFrom(name), name, `${name} was refused`);
    });
  }

  it("refuses an email address, and says so", () => {
    // Pasted into the wrong field, which is the only way it gets here.
    assert.equal(nameFrom("danny@balans.ng"), undefined);
    assert.match(refusal("danny@balans.ng"), /email address/i);
  });

  it("refuses a web address, and says so", () => {
    for (const url of ["https://balans.ng", "www.balans.ng"]) {
      assert.equal(nameFrom(url), undefined, `${url} was accepted`);
      assert.match(refusal(url), /web address/i);
    }
  });

  it("refuses something with no letters in it at all", () => {
    // This is what catches a phone number: a phone number has no letters.
    for (const text of ["08012345678", "+234 801 234 5678", "12345", "???", "..."]) {
      assert.equal(nameFrom(text), undefined, `${text} was accepted`);
      assert.match(refusal(text), /at least one letter/i);
    }
  });

  it("keeps a name's own accents and capitals", () => {
    /*
     * `titleCaseName` tested for "already capitalised" with /[A-Z]/, which
     * does not match "À" — so an accented name looked like something a phone
     * keyboard had produced and was lower-cased, on an invoice, for a name
     * somebody had typed correctly. Yoruba and Igbo names are exactly the
     * ones that hit it.
     */
    assert.equal(nameFrom("Àkàndé & Sons"), "Àkàndé & Sons");
    assert.equal(nameFrom("àkàndé & sons"), "Àkàndé & Sons", "and it still capitalises");
    assert.equal(nameFrom("ọlá studios"), "Ọlá Studios");
    assert.equal(nameFrom("MTN"), "MTN", "deliberate capitals survive");
  });

  it("has no rule about digits, deliberately", () => {
    // "9ja Prints" and "247 Logistics" are real, and a bare phone number is
    // already caught by needing a letter. A digits rule would only cost.
    assert.equal(nameFrom("9ja Prints"), "9ja Prints");
    assert.equal(nameFrom("247 Logistics"), "247 Logistics");
  });

  it("still refuses one character and eighty-one", () => {
    assert.equal(nameFrom("D"), undefined);
    assert.equal(nameFrom("x".repeat(81)), undefined);
    // Accepted, and title-cased on the way in like every other name.
    assert.equal(nameFrom("x".repeat(80)), "X" + "x".repeat(79));
  });
});

describe("starting setup again", () => {
  /*
   * Cancel used to answer with the first typed question — a different and
   * worse beginning than a new number gets. Somebody who has just backed out
   * of setup is the person least sure about it, and a bare question is the
   * wrong half of the product to hand them.
   */
  for (const state of [
    "onboarding:business_name",
    "onboarding:bank",
    "onboarding:confirm_account",
    "onboarding:email",
  ] as const) {
    it(`offers the same beginning from ${state}`, () => {
      const out = say(state, "cancel");
      const flow = out.effects.find((e) => e.type === "send_flow");

      assert.ok(flow, "it should offer the form, not just a question");
      assert.equal(flow.key, "onboarding");
      assert.match(flow.image ?? "", /welcome\.png$/, "the card a new number gets");
      assert.equal(flow.cta, "Set up Balans");
    });
  }

  it("forgets everything that was half-answered", () => {
    // Starting again means starting again. A half-entered email surviving a
    // restart is how somebody ends up verifying an address they meant to
    // replace.
    const out = say("onboarding:bank", "cancel");
    assert.deepEqual(out.context, {});
  });

  it("still asks in words when there is no form", () => {
    const out = say("onboarding:bank", "cancel");
    const flow = out.effects.find((e) => e.type === "send_flow");
    assert.match(flow?.fallback?.line ?? "", /start again/i);
    assert.equal(flow?.fallback?.holdAt, "onboarding:business_name");
  });
});
