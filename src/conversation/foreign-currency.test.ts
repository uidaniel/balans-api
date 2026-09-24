/**
 * What happens when somebody writes a price that is not in naira.
 *
 * The failure being prevented is one sentence long: a Nigerian freelancer
 * with a client in London writes "invoice Acme £500 for brand identity", and
 * Balans sends an invoice for ₦500. Nothing downstream catches it. ₦500 is a
 * valid amount, the invoice is well-formed, the payment link works, and the
 * client pays it — a month's work settled for the price of a bottle of water,
 * under the freelancer's own name.
 *
 * Until the international path is built, the entire feature is the refusal.
 * These tests are about the refusal being unavoidable: not attached to the
 * draft step, not attached to the pattern reader, but across every way a
 * price can enter the machine, and not removable by the feature flag.
 *
 * `end to end` here means through the real parser, because the guard is only
 * worth anything if the currency survives whichever of the three readers
 * happens to answer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Civil } from "../../core/dates.ts";
import { readCurrency } from "../../core/currency.ts";
import { step, type Context, type State } from "./machine.ts";
import { normalise, type Parsed } from "../parser/schema.ts";
import { extractDocument } from "../parser/extract.ts";

const NOW: Civil = { y: 2026, m: 9, d: 23 };

/**
 * A message read the way `parseMessage` reads one: the pattern reader for the
 * words, the currency reader for the mark, stamped together.
 *
 * Built here rather than calling `parseMessage` because that would reach for
 * the model on anything the pattern cannot read, and the point of these tests
 * is the shape of the result, not the network.
 */
function reading(text: string): Parsed {
  const money = readCurrency(text);
  const pattern = extractDocument(text, NOW);
  if (pattern) return { ...pattern, money };

  // Nothing structured in it. An empty document parse, which is what the
  // model would return for a message it could not place, plus the currency.
  return normalise(
    {
      intent: "create_invoice",
      client_name: null,
      client_email: null,
      line_items: [],
      total_amount: null,
      due_date: null,
      document_number: null,
      options: {
        deposit_percent: null,
        instalments: null,
        pass_fees_to_client: null,
        vat_percent: null,
        notes: null,
      },
      correction: null,
      confidence: 0.9,
    },
    NOW,
    "model",
    money,
  );
}

const say = (text: string, state: State = "idle", context: Context = {}) =>
  step(state, context, { text, today: NOW, parsed: reading(text) } as never, "1.0");

describe("a price in dollars or pounds", () => {
  it("is refused rather than read as naira", () => {
    const out = say("invoice Acme Ltd $500 for brand identity");
    assert.match(String(out.replies[0]), /cannot invoice in dollars yet/i);
    assert.deepEqual(out.effects, [], "something happened anyway");
  });

  it("says which currency it means, so the answer is not a riddle", () => {
    assert.match(String(say("invoice Acme £500 for the logo").replies[0]), /pounds/i);
  });

  it("is refused in the form that would actually have gone wrong", () => {
    /*
     * The dangerous case, and the reason a three-digit example proves little.
     * "$1,200" carries four digits, which is exactly what the naira reader
     * accepts as a bare amount — so without the guard this message produces a
     * clean, confident, confirmable draft for ₦1,200.
     */
    const out = say("invoice Acme $1,200 for the website");
    assert.deepEqual(out.effects, []);
    assert.doesNotMatch(String(out.replies[0]), /1,200/, "the naira figure was drafted");
    assert.match(String(out.replies[0]), /dollars/i);
  });

  it("leaves whatever was on screen exactly as it was", () => {
    // A refusal that also cleared somebody's draft would be a second bug
    // wearing the first one's coat.
    const doc = { type: "invoice" as const, clientName: "Tunde", lines: [], totalKobo: 20_000_00 };
    const out = say("change it to $600", "awaiting_confirm", { doc } as Context);
    assert.equal(out.next, "awaiting_confirm");
    assert.deepEqual(out.context.doc, doc);
  });
});

describe("every way a price gets in", () => {
  /*
   * The guard is at the top of the machine rather than beside the draft, and
   * this is what that buys. A foreign amount can arrive as a new invoice, as
   * a correction to one on screen, or as the answer to "how much?" — three
   * code paths, each of which would otherwise hand "$600" to a reader that
   * strips the mark and returns ₦600.
   */
  const states: [string, State, Context][] = [
    ["a new invoice", "idle", {}],
    ["the answer to how much", "awaiting_field:amount", { doc: { type: "invoice", clientName: "Tunde", lines: [] } } as never],
    ["a correction to the draft", "awaiting_confirm", { doc: { type: "invoice", clientName: "Tunde", lines: [], totalKobo: 20_000_00 } } as never],
  ];

  for (const [what, state, context] of states) {
    it(`refuses it as ${what}`, () => {
      const out = say("$600", state, context);
      assert.match(String(out.replies[0]), /dollars/i, what);
      assert.deepEqual(out.effects, [], what);
    });
  }
});

describe("currencies Balans will never take", () => {
  it("names them, because the answer will still be no tomorrow", () => {
    // "I did not understand that" would be a lie. It was understood exactly.
    assert.match(String(say("invoice Acme EUR 500 for the rebrand").replies[0]), /euros/i);
    assert.match(String(say("invoice Acme ZAR 5000 for the rebrand").replies[0]), /rand/i);
  });
});

describe("two currencies in one message", () => {
  it("asks which, rather than picking", () => {
    /*
     * Section 5, by name. "$500 or 700k" is somebody thinking aloud, both
     * readings are defensible, and the gap between them is three orders of
     * magnitude. There is no correct answer to compute.
     */
    const out = say("invoice Acme $500 or 700k for brand identity");
    assert.match(String(out.replies[0]), /Which one\?/);
    assert.match(String(out.replies[0]), /dollars/);
    assert.match(String(out.replies[0]), /naira/);
    assert.deepEqual(out.effects, []);
  });
});

describe("naira, which must be untouched by all of this", () => {
  it("still drafts the sentence the product teaches", () => {
    const out = say("Invoice Zenith Homes 350k for duplex 3D render, due Friday");
    assert.equal(out.next, "awaiting_confirm");
    // The draft leaves as an effect, not a reply: the card is rendered by
    // whatever is holding the conversation.
    const draft = out.effects.find((e) => e.type === "save_draft");
    assert.ok(draft, "no draft was saved");
    assert.equal(draft.doc.lines[0]?.unitAmountKobo, 350_000_00);
  });

  it("still drafts a client whose name ends in n", () => {
    // The lookbehind that stops a currency mark eating the end of a name.
    // "Invoice Steven 5k" is Steven, not Steve being billed N5k — and it is
    // not a foreign-currency message either.
    const out = say("invoice Steven 5k for the flyer");
    assert.equal(out.next, "awaiting_confirm");
  });
});

describe("the feature flag", () => {
  it("does not yet open the door, whatever it is set to", () => {
    /*
     * `INTL_ENABLED` is the switch for the rest of this feature, and the
     * branch it will control refuses regardless for now. Deliberately: a flag
     * that opens a door onto an unbuilt room is worse than no flag. Letting
     * "$1,200" through today would not produce a dollar invoice, it would
     * produce a ₦1,200 one.
     *
     * When the draft path lands, this test is what has to change — and it
     * changes by asserting that a dollar draft appears, not by deletion.
     */
    const before = process.env.INTL_ENABLED;
    process.env.INTL_ENABLED = "true";
    try {
      const out = say("invoice Acme $1,200 for the website");
      assert.deepEqual(out.effects, [], "a flag let an unpriced foreign invoice through");
      assert.doesNotMatch(String(out.replies[0]), /1,200/);
    } finally {
      if (before === undefined) delete process.env.INTL_ENABLED;
      else process.env.INTL_ENABLED = before;
    }
  });
});
