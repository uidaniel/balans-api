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
    assert.equal(out.next, "onboarding:business_name");
  });

  it("does not interfere once setup is done", () => {
    // At idle the commands are the point of the product.
    const out = say("idle", "/pro");
    assert.doesNotMatch(out.replies.join(" "), /once you are set up/i);
  });
});
