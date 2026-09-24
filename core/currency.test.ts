/**
 * Reading a currency out of a sentence.
 *
 * The International PRD asks for "at least 30 foreign-currency examples in
 * the parser regression set", and the reason is not coverage for its own
 * sake. Every failure here has the same shape and the same cost: a freelancer
 * writes £500 and Balans writes an invoice for ₦500. Nothing downstream can
 * catch that, because ₦500 is a perfectly valid number and the invoice is
 * perfectly well-formed. It is simply somebody's month of work priced at the
 * cost of a bottle of water, sent to a client under their own name.
 *
 * So the examples below are not variations on a theme. They are the ways
 * people actually write money in a WhatsApp message, and each one that is
 * missing is a real invoice that goes out wrong.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readCurrency, readAmounts, formatMoney, type CurrencyRead } from "./currency.ts";

/** What a message resolves to, flattened so a table can assert on it. */
const read = (text: string): string => {
  const r: CurrencyRead = readCurrency(text);
  switch (r.kind) {
    case "naira":
      return "NGN";
    case "foreign":
      return r.amountMinor === null ? r.currency : `${r.currency} ${r.amountMinor}`;
    case "mixed":
      return `mixed:${r.currencies.join("+")}`;
    case "unsupported":
      return `no:${r.named}`;
  }
};

describe("the ways people write dollars and pounds", () => {
  /*
   * Symbols, codes and words, against the amount shorthand this product has
   * always taken. $1.2k is twelve hundred dollars: the shorthand is about the
   * digits and has nothing to do with naira, which is why the magnitude
   * parser was split out from the naira one rather than copied.
   */
  const cases: [string, string][] = [
    // Symbols
    ["Invoice Acme Ltd $500 for brand identity", "USD 50000"],
    ["Invoice Acme £500 for brand identity", "GBP 50000"],
    ["invoice john $1,200 for the website", "USD 120000"],
    ["invoice john $1.2k for the website", "USD 120000"],
    ["invoice john £1.2k for the website", "GBP 120000"],
    ["bill Sarah $2.5k for consulting", "USD 250000"],
    ["invoice Kemi $500.50 for edits", "USD 50050"],
    ["invoice Kemi £99.99 for the plugin", "GBP 9999"],
    ["charge Acme $10k for the retainer", "USD 1000000"],
    ["invoice Acme $1.5m for the build", "USD 150000000"],
    ["invoice Acme $5h for the favicon", "USD 50000"],

    // Codes
    ["invoice Acme USD 500 for brand identity", "USD 50000"],
    ["invoice Acme usd500 for brand identity", "USD 50000"],
    ["invoice Acme GBP 500 for brand identity", "GBP 50000"],
    ["invoice Acme gbp 1.2k for brand identity", "GBP 120000"],
    ["invoice Acme US$500 for brand identity", "USD 50000"],
    ["invoice Acme US $500 for brand identity", "USD 50000"],

    // Words, after the number
    ["invoice Acme 500 dollars for brand identity", "USD 50000"],
    ["invoice Acme 500 dollar for brand identity", "USD 50000"],
    ["invoice Acme 2k dollars for brand identity", "USD 200000"],
    ["invoice Acme 500 pounds for the logo", "GBP 50000"],
    ["invoice Acme 500 pound for the logo", "GBP 50000"],
    ["invoice Acme 500 quid for the logo", "GBP 50000"],
    ["invoice Acme 1.2k usd for the logo", "USD 120000"],
    ["invoice Acme 750 GBP for the logo", "GBP 75000"],

    // With everything else a real message carries
    ["Invoice Acme Ltd $500 for brand identity, due Friday", "USD 50000"],
    ["invoice Acme $500 for brand identity, due 2026-10-02", "USD 50000"],
    ["invoice Acme $500 for brand identity, due 15/10", "USD 50000"],
    ["invoice Acme $500 for 3 logos", "USD 50000"],
    ["invoice Acme $500 for brand identity, 50% deposit", "USD 50000"],
    ["invoice Acme $500 for brand identity in 3 instalments", "USD 50000"],
    ["quote Acme $500 for brand identity", "USD 50000"],
    ["collect $500 from Acme", "USD 50000"],

    // Two lines in one currency: an invoice, not a clash.
    ["invoice Acme $200 for the logo and $300 for the site", "USD"],
    ["invoice Acme £200 for the logo and £300 for the site", "GBP"],
  ];

  for (const [text, want] of cases) {
    it(text, () => assert.equal(read(text), want));
  }

  it("covers at least the thirty the PRD asks for", () => {
    assert.ok(cases.length >= 30, `only ${cases.length} foreign examples`);
  });
});

describe("naira, which is everything else", () => {
  const cases: [string, string][] = [
    ["Invoice Zenith Homes 350k for duplex 3D render, due Friday", "NGN"],
    ["invoice Tunde 20k for logo design", "NGN"],
    ["invoice Tunde N350,000 for the render", "NGN"],
    ["invoice Tunde ₦350,000 for the render", "NGN"],
    ["invoice Tunde NGN 350000 for the render", "NGN"],
    ["invoice Tunde 350000 naira for the render", "NGN"],
    // The lookbehind that stops a currency mark eating the end of a name.
    ["invoice Steven 5k for the flyer", "NGN"],
    ["invoice MTN 20k for the banner", "NGN"],
  ];
  for (const [text, want] of cases) {
    it(text, () => assert.equal(read(text), want));
  }
});

describe("what it refuses to decide", () => {
  it("asks which one, when the message says both", () => {
    // Section 5, by name: "$500 or 700k" is somebody thinking aloud. There is
    // no correct answer to compute, only a question to ask.
    assert.equal(read("invoice Acme $500 or 700k for brand identity"), "mixed:dollars+naira");
    assert.equal(read("invoice Acme $500 or 700,000 for brand identity"), "mixed:dollars+naira");
    assert.equal(read("invoice Acme $500 / N700k"), "mixed:dollars+naira");
  });

  it("asks which one, when the message says two foreign currencies", () => {
    assert.equal(read("invoice Acme $500 or £400"), "mixed:dollars+pounds");
  });

  it("does not manufacture a clash out of a date or a quantity", () => {
    // The year in a date and the count in "3 logos" are four digits and one
    // digit of something that is not money. Reading either as naira would
    // stop a perfectly clear dollar invoice to ask a question about itself.
    assert.equal(read("invoice Acme $500 for the rebrand, due 2026-10-02"), "USD 50000");
    assert.equal(read("invoice Acme $500 for 3 logos and 2 banners"), "USD 50000");
    assert.equal(read("invoice Acme $500 for brand identity, 25% deposit"), "USD 50000");
  });

  it("keeps the currency when the date clause was not a date clause", () => {
    /*
     * The due clause is found by words, and "by" is a word that turns up in
     * sentences with no date in them. Cutting at it may remove a false clash;
     * it may never remove the mark that says this is a dollar invoice.
     */
    assert.equal(read("invoice Acme for the logos by hand $500"), "USD 50000");
    assert.equal(read("invoice Acme for the mural, painted by Tunde, £900"), "GBP 90000");
  });
});

describe("currencies it knows and will not take", () => {
  /*
   * The quiet disaster this prevents. A reader that knows only $ and £ sees
   * "EUR 500" as a bare number, finds no foreign mark, and writes a ₦500
   * invoice — silently, with nothing anywhere to catch it. Recognising more
   * than we accept is the whole point.
   */
  const cases: [string, string][] = [
    ["invoice Acme EUR 500 for the rebrand", "no:euros"],
    ["invoice Acme €500 for the rebrand", "no:euros"],
    ["invoice Acme 500 euros for the rebrand", "no:euros"],
    ["invoice Acme ZAR 5000 for the rebrand", "no:rand"],
    ["invoice Acme 5000 rand for the rebrand", "no:rand"],
    ["invoice Acme GHS 5000 for the rebrand", "no:cedis"],
    ["invoice Acme CAD 500 for the rebrand", "no:Canadian dollars"],
    ["invoice Acme AUD 500 for the rebrand", "no:Australian dollars"],
    ["invoice Acme AED 2000 for the rebrand", "no:dirhams"],
    ["invoice Acme ¥50000 for the rebrand", "no:yen"],
    ["invoice Acme ₹50000 for the rebrand", "no:rupees"],
  ];
  for (const [text, want] of cases) {
    it(text, () => assert.equal(read(text), want));
  }

  it("does not refuse a client who happens to be called Rand", () => {
    // Words only count behind the number. "Invoice Rand 500k" is a person;
    // "500 rand" is money. A reader that took the word in front of a number
    // as a currency would refuse to invoice somebody by name.
    assert.equal(read("invoice Rand 500k for the mural"), "NGN");
    assert.equal(read("invoice Yen 500k for the mural"), "NGN");
  });
});

describe("reading the amounts out of a line", () => {
  it("keeps each amount with the mark that was on it", () => {
    const tokens = readAmounts("invoice Acme $200 for the logo and $300 for the site");
    assert.deepEqual(
      tokens.map((t) => [t.currency, t.minor]),
      [
        ["USD", 20000],
        ["USD", 30000],
      ],
    );
  });

  it("leaves a percentage alone", () => {
    assert.deepEqual(readAmounts("$1,000 with 50% deposit").map((t) => t.raw), ["$1,000"]);
  });
});

describe("saying it back", () => {
  it("always shows the cents on a foreign price", () => {
    // "$500" reads as about five hundred. "$500.00" is a price.
    assert.equal(formatMoney(50000, "USD"), "$500.00");
    assert.equal(formatMoney(50050, "USD"), "$500.50");
    assert.equal(formatMoney(120000, "GBP"), "£1,200.00");
  });

  it("keeps the house style for naira", () => {
    assert.equal(formatMoney(66_350_000, "NGN"), "₦663,500");
    assert.equal(formatMoney(5_467_006, "NGN"), "₦54,670.06");
  });
});
