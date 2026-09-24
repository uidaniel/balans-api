/**
 * A draft priced abroad, from the sentence to the saved document.
 *
 * The rule these tests exist to hold: above the machine a price is in
 * whatever currency somebody wrote, below it everything is naira. One
 * conversion, at one recorded rate, and nothing downstream — totals, VAT,
 * payment parts, reminders, the summary, the fee engine — learns a new unit.
 *
 * Two things can go wrong at that seam and both are silent. A figure can fail
 * to be converted, so a $500 invoice goes out at ₦500. Or it can be converted
 * twice, so ₦663,500 becomes ₦880 million. Neither raises anything; both
 * produce a perfectly well-formed invoice with the wrong number on it.
 *
 * The third failure is the correction. "make it 600" against a dollar draft
 * carries no mark at all, and the only thing that knows it means dollars is
 * the invoice it is being applied to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Civil } from "../../core/dates.ts";
import type { Quote } from "../fx/rate.ts";

/*
 * Everything below the flag is loaded dynamically, and that is not
 * fastidiousness.
 *
 * `config.ts` parses the environment once, at import, into a frozen object —
 * deliberately, so a misconfigured deployment fails at boot rather than at
 * the first request. A static import anywhere in this file pulls that module
 * in before the first line of the body runs: `extract.ts` reaches `parts.ts`
 * reaches the database pool reaches the config. Set the variable after that
 * and it changes nothing, and every test here would pass for the wrong
 * reason — refused, with nothing asserting why.
 *
 * Node runs each test file in its own process, so this is confined to this
 * one. Type-only imports above are erased and pull in nothing.
 */
process.env.INTL_ENABLED = "true";

const { step } = await import("./machine.ts");
const { readCurrency } = await import("../../core/currency.ts");
const { extractDocument } = await import("../parser/extract.ts");
const { readCorrection } = await import("../parser/corrections.ts");

type Context = import("./machine.ts").Context;
type PendingDoc = import("./machine.ts").PendingDoc;

const NOW: Civil = { y: 2026, m: 9, d: 23 };

/** The rate in the PRD's worked example. */
const QUOTE: Quote = {
  currency: "USD",
  pair: "USDNGN",
  rate: 1327,
  source: "open.er-api.com",
  fetchedAt: new Date("2026-09-23T09:00:00Z"),
};

const parsed = (text: string) => {
  const money = readCurrency(text);
  return { ...extractDocument(text, NOW, money)!, money };
};

/**
 * `quote` is explicit rather than defaulted, because "no rate at all" is one
 * of the cases under test and a default would quietly supply one.
 */
/**
 * `null` means "no rate came with the message", which is one of the cases
 * under test. It cannot be `undefined`, because a default parameter would
 * quietly supply the rate the test is checking we do without.
 */
const drafted = (text: string, quote: Quote | null = QUOTE): PendingDoc | null => {
  const out = step(
    "idle",
    {},
    { text, today: NOW, parsed: parsed(text), quote: quote ?? undefined } as never,
    "1.0",
  );
  const saved = out.effects.find((e) => e.type === "save_draft");
  return saved ? saved.doc : null;
};

describe("a dollar invoice, with the feature on", () => {
  it("converts the price once, at the rate it was handed", () => {
    // The PRD's worked example: $500 at 1,327 is ₦663,500.
    const doc = drafted("Invoice Acme Ltd $500 for brand identity, due Friday");
    assert.equal(doc?.lines[0]?.unitAmountKobo, 663_500_00);
  });

  it("keeps what was agreed, which is what the client said yes to", () => {
    const doc = drafted("Invoice Acme Ltd $500 for brand identity");
    assert.equal(doc?.lines[0]?.originalUnitAmountMinor, 500_00);
    assert.equal(doc?.foreign?.amountMinor, 500_00);
    assert.equal(doc?.foreign?.currency, "USD");
  });

  it("records the rate and who said it, on the draft itself", () => {
    /*
     * Acceptance criterion 6. Not for tidiness: when a freelancer asks in
     * March why their January invoice converted at 1,327, the answer has to
     * be on the document rather than in a recollection — and when a client
     * queries the naira figure, this is what explains it.
     */
    const doc = drafted("Invoice Acme $500 for brand identity");
    assert.equal(doc?.foreign?.rate, 1327);
    assert.equal(doc?.foreign?.source, "open.er-api.com");
    assert.equal(doc?.foreign?.fetchedAt, "2026-09-23T09:00:00.000Z");
  });

  it("is still refused without a rate, rather than drafted at nothing", () => {
    // Section 6 forbids guessing one. No fallback, no hard-coded 1,300 — the
    // draft simply does not happen.
    assert.equal(drafted("Invoice Acme $500 for brand identity", null), null);
  });

  it("does not take a pound rate for a dollar invoice", () => {
    /*
     * A quote for the wrong pair would convert $500 at 1,791 and produce an
     * invoice for ₦895,500 — 35% over, from a rate that is perfectly valid
     * and simply not this invoice's.
     */
    const pounds: Quote = { ...QUOTE, currency: "GBP", pair: "GBPNGN", rate: 1791.751317 };
    assert.equal(drafted("Invoice Acme $500 for brand identity", pounds), null);
  });

  it("leaves a naira invoice entirely alone", () => {
    const doc = drafted("Invoice Zenith Homes 350k for duplex 3D render, due Friday");
    assert.equal(doc?.lines[0]?.unitAmountKobo, 350_000_00);
    assert.equal(doc?.foreign, undefined);
    assert.equal(doc?.lines[0]?.originalUnitAmountMinor, undefined);
  });
});

describe("correcting a draft that is in dollars", () => {
  /** A $500 draft, converted, as `startDocument` would have left it. */
  const onScreen = (): PendingDoc => ({
    type: "invoice",
    clientName: "Acme Ltd",
    lines: [
      {
        description: "brand identity",
        qty: 1,
        unitAmountKobo: 663_500_00,
        originalUnitAmountMinor: 500_00,
      },
    ],
    foreign: {
      currency: "USD",
      amountMinor: 500_00,
      rate: 1327,
      source: "open.er-api.com",
      fetchedAt: "2026-09-23T09:00:00.000Z",
    },
  });

  /** The way `handle.ts` reads one: in the currency of the draft on screen. */
  const correcting = (text: string, quote?: Quote): PendingDoc => {
    const doc = onScreen();
    const correction = readCorrection(text, NOW, {
      kind: "foreign",
      currency: doc.foreign!.currency,
      amountMinor: null,
    });
    assert.ok(correction, `nothing read out of ${JSON.stringify(text)}`);

    const out = step(
      "awaiting_confirm",
      // `draftId` is what says a draft is really waiting; without it the
      // machine answers "there is no draft waiting", which is right.
      { doc, draftId: "11111111-1111-1111-1111-111111111111" } as Context,
      { text, today: NOW, correction, quote } as never,
      "1.0",
    );
    const saved = out.effects.find((e) => e.type === "save_draft");
    assert.ok(saved, "no draft came back");
    return saved.doc;
  };

  it("reads a bare number as the invoice's money, not as naira", () => {
    /*
     * The one that has no mark to read. Applied to the kobo figures, "make it
     * 600" would turn a $500 invoice into one for ₦600 — a month of work
     * priced under a dollar, with nothing anywhere to say what happened.
     */
    const doc = correcting("make it 600");
    assert.equal(doc.foreign?.amountMinor, 600_00);
    assert.equal(doc.lines[0]?.unitAmountKobo, 796_200_00); // 600 × 1,327
  });

  it("reads one written with its mark the same way", () => {
    assert.equal(correcting("change it to $750").foreign?.amountMinor, 750_00);
  });

  it("re-quotes when the amount changes, and only then", () => {
    /*
     * Section 6: "If the user edits the amount, re-quote with the current
     * rate." An edit makes a different invoice. A new due date does not, and
     * re-pricing it would move a figure the user had already agreed to for a
     * reason that has nothing to do with money.
     */
    const today: Quote = { ...QUOTE, rate: 1400, fetchedAt: new Date("2026-09-24T09:00:00Z") };

    const repriced = correcting("make it 600", today);
    assert.equal(repriced.foreign?.rate, 1400);
    assert.equal(repriced.lines[0]?.unitAmountKobo, 840_000_00);

    const untouched = correcting("due next Friday");
    assert.equal(untouched.foreign?.rate, 1327);
    assert.equal(untouched.lines[0]?.unitAmountKobo, 663_500_00);
  });

  it("does not convert twice when nothing about the money changed", () => {
    /*
     * The other silent failure. Running the conversion over figures that are
     * already naira turns ₦663,500 into ₦880,464,500 — and a correction that
     * only changed the client's name would have done it.
     */
    const doc = correcting("change the client to Acme Holdings");
    assert.equal(doc.clientName, "Acme Holdings");
    assert.equal(doc.lines[0]?.unitAmountKobo, 663_500_00);
    assert.equal(doc.foreign?.amountMinor, 500_00);
  });

  it("keeps a renamed line at the price it was agreed at", () => {
    const doc = correcting("change brand identity to brand identity and guidelines");
    assert.equal(doc.lines[0]?.description, "brand identity and guidelines");
    assert.equal(doc.lines[0]?.originalUnitAmountMinor, 500_00);
    assert.equal(doc.lines[0]?.unitAmountKobo, 663_500_00);
  });

  it("adds a line in the invoice's currency", () => {
    const doc = correcting("add social templates 200");
    assert.equal(doc.lines.length, 2);
    assert.equal(doc.lines[1]?.originalUnitAmountMinor, 200_00);
    assert.equal(doc.lines[1]?.unitAmountKobo, 265_400_00);
    // And the document's agreed total is the sum of what was agreed.
    assert.equal(doc.foreign?.amountMinor, 700_00);
  });
});
