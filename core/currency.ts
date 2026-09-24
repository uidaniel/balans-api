/**
 * Which currency somebody meant (International PRD section 5).
 *
 * A Nigerian freelancer with a client in London writes "invoice Acme £500 for
 * brand identity" and means five hundred pounds. The same sentence read as
 * naira is an invoice for about a three-hundredth of the work's value, sent
 * under their name, to a client who will pay it. So the mark in front of the
 * number is not decoration — it is the difference between being paid and
 * being underpaid by a factor of 1,800, and reading it is worth doing
 * deterministically rather than asking a language model to remember.
 *
 * Three rules shape everything here.
 *
 * It never guesses. "$" is always USD, because the PRD says so and because
 * the alternative is picking between five dollars on a coin flip. A currency
 * that is real but unsupported — euros, rand, cedis — is *recognised and
 * refused*, which is the part that is easy to leave out: a reader that only
 * knows $ and £ sees "EUR 500" as a bare number and quietly writes a ₦500
 * invoice. Recognising more than we accept is how that cannot happen.
 *
 * It refuses ambiguity out loud. "$500 or 700k" is somebody thinking aloud,
 * not an instruction, and there is no safe way to pick. The PRD's answer is
 * to ask which one, so this reports the clash rather than resolving it.
 *
 * And it does no arithmetic beyond counting digits. Conversion to naira
 * happens later, against a rate that is fetched, recorded and locked. This
 * file answers one question: what currency, and how many of its minor units.
 */

import { parseMagnitudeToMinor } from "./amount.ts";

/** What Balans can invoice in. Everything else is refused by name. */
export const CURRENCIES = ["NGN", "USD", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The two that go through Paystack rather than Monnify. */
export const FOREIGN = ["USD", "GBP"] as const;
export type Foreign = (typeof FOREIGN)[number];

export const isForeign = (c: Currency): c is Foreign => c !== "NGN";

export type CurrencyInfo = {
  code: Currency;
  symbol: string;
  /** For a sentence: "five hundred dollars". */
  one: string;
  many: string;
};

export const INFO: Record<Currency, CurrencyInfo> = {
  NGN: { code: "NGN", symbol: "₦", one: "naira", many: "naira" },
  USD: { code: "USD", symbol: "$", one: "dollar", many: "dollars" },
  GBP: { code: "GBP", symbol: "£", one: "pound", many: "pounds" },
};

/* -------------------------------------------------------------------------- */
/* Money we can name but will not take                                        */
/* -------------------------------------------------------------------------- */

/**
 * Not a completeness exercise — it is the list of marks likely to turn up in
 * a Nigerian freelancer's chat and be read as a bare number if nothing here
 * knew them. Euros and rand from clients, cedis and shillings from the
 * region, dirhams from the Gulf where a lot of this work goes, and the dollar
 * codes that are not the US one.
 *
 * Each of these produces "we do not do that yet" rather than a naira invoice.
 * Adding one to `CURRENCIES` is the only thing that should ever make one
 * payable.
 */
const UNSUPPORTED_CODES: Record<string, string> = {
  EUR: "euros",
  "€": "euros",
  ZAR: "rand",
  GHS: "cedis",
  KES: "shillings",
  AED: "dirhams",
  CAD: "Canadian dollars",
  AUD: "Australian dollars",
  NZD: "New Zealand dollars",
  CHF: "francs",
  JPY: "yen",
  "¥": "yen",
  INR: "rupees",
  "₹": "rupees",
  CNY: "yuan",
  SAR: "riyals",
};

/**
 * The same currencies as words, and only ever *after* the number.
 *
 * "500 rand" is money. "Invoice Rand 500k" is a client called Rand, and a
 * reader that took the word in front of a number as a currency would refuse
 * to invoice them. Codes and symbols are safe in front of a number because
 * nobody is called EUR; words are not, so they only count behind it.
 */
const UNSUPPORTED_WORDS: Record<string, string> = {
  euros: "euros",
  euro: "euros",
  rand: "rand",
  cedis: "cedis",
  shillings: "shillings",
  dirhams: "dirhams",
  francs: "francs",
  yen: "yen",
  rupees: "rupees",
  yuan: "yuan",
  riyals: "riyals",
};

const nameOf = (key: string): string =>
  UNSUPPORTED_CODES[key.toUpperCase()] ??
  UNSUPPORTED_CODES[key] ??
  UNSUPPORTED_WORDS[key.toLowerCase()] ??
  key;

/* -------------------------------------------------------------------------- */
/* Reading an amount                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Marks that fix a currency in front of a number, longest first so "usd" is
 * never read as "us" and "US$" is never read as a bare dollar sign.
 */
const MARKS: { re: string; currency: Currency }[] = [
  { re: String.raw`us\s?\$`, currency: "USD" },
  { re: String.raw`usd`, currency: "USD" },
  { re: String.raw`\$`, currency: "USD" },
  { re: String.raw`gbp`, currency: "GBP" },
  { re: String.raw`£`, currency: "GBP" },
  { re: String.raw`ngn`, currency: "NGN" },
  { re: String.raw`₦`, currency: "NGN" },
];

/**
 * The words, after the number: "500 dollars", "20k quid".
 *
 * "quid" is in because people write it and it means exactly one thing.
 * "bucks" is not: in Lagos it is used for naira as often as for dollars,
 * which makes it the opposite of evidence.
 */
const TRAILING: { re: string; currency: Currency }[] = [
  { re: String.raw`dollars?`, currency: "USD" },
  { re: String.raw`usd`, currency: "USD" },
  { re: String.raw`pounds?`, currency: "GBP" },
  { re: String.raw`quid`, currency: "GBP" },
  { re: String.raw`gbp`, currency: "GBP" },
  { re: String.raw`naira`, currency: "NGN" },
  { re: String.raw`ngn`, currency: "NGN" },
];

const MAGNITUDE = String.raw`\d[\d,]*(?:\.\d+)?\s?[hkm]?`;

const LEADING_MARK = MARKS.map((m) => m.re).join("|");
const TRAILING_WORD = TRAILING.map((m) => m.re).join("|");

const escape = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UNSUPPORTED_LEADING = Object.keys(UNSUPPORTED_CODES).map(escape).join("|");
const UNSUPPORTED_TRAILING = [...Object.keys(UNSUPPORTED_CODES), ...Object.keys(UNSUPPORTED_WORDS)]
  .map(escape)
  .join("|");

/*
 * Every amount in a sentence, with whatever mark was attached to it.
 *
 * One alternation, so the marked forms are tried before the bare one and a
 * single pass can report position. The bare "n" prefix is the awkward case
 * and is handled exactly as `parser/extract.ts` handles it: it counts only
 * when it is not the tail of a word, because "Invoice Steven 5k" is Steven,
 * not Steve being billed N5k.
 */
const TOKEN = new RegExp(
  String.raw`(?<bad>${UNSUPPORTED_LEADING})\s?(?<badnum>${MAGNITUDE})` +
    String.raw`|(?<num2>${MAGNITUDE})\s?(?<bad2>${UNSUPPORTED_TRAILING})\b` +
    String.raw`|(?<mark>${LEADING_MARK})\s?(?<num>${MAGNITUDE})` +
    String.raw`|(?<![a-z])n\s?(?<nnum>${MAGNITUDE})` +
    String.raw`|(?<num3>${MAGNITUDE})\s?(?<trail>${TRAILING_WORD})\b` +
    String.raw`|(?<bare>${MAGNITUDE})`,
  "gi",
);

export type AmountToken = {
  /** Null when the number carried no mark at all: "700k", "20000". */
  currency: Currency | null;
  /** A currency we recognise but will not invoice in, by name: "euros". */
  unsupported?: string;
  /** Minor units — cents, pence, kobo. Null when it would not convert. */
  minor: number | null;
  /** As written, mark and all, so a message can quote the user back. */
  raw: string;
  index: number;
};

/**
 * Whether a bare number is an amount or just a number in a sentence.
 *
 * "2 logos" is a quantity, "50%" is a share and "2026" is a year; none of
 * them is money. The same rule as the pattern reader uses: a bare number
 * needs four digits or a multiplier to count. It is not a clever rule, and
 * the place it matters is narrow — it decides whether a sentence looks like
 * it has naira in it as well as dollars, which is the question that makes
 * Balans stop and ask.
 */
function bareIsMoney(raw: string): boolean {
  const digits = raw.replace(/[^\d]/g, "");
  return /[hkm]\s*$/i.test(raw.trim()) || digits.length >= 4;
}

/**
 * Every amount in the message, in order.
 *
 * `%` is excluded here rather than in the pattern, because a percentage sign
 * comes *after* the number and the pattern would have to look forward past
 * the multiplier to see it. "50% deposit" is a share of an amount and not an
 * amount.
 */
export function readAmounts(text: string): AmountToken[] {
  const out: AmountToken[] = [];

  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups!;
    if (/^\s*%/.test(text.slice(m.index + m[0].length))) continue;

    const badMark = g.bad ?? g.bad2;
    if (badMark !== undefined) {
      out.push({ currency: null, unsupported: nameOf(badMark), minor: null, raw: m[0].trim(), index: m.index });
      continue;
    }

    const magnitude = (g.num ?? g.nnum ?? g.num3 ?? g.bare)!;
    const currency: Currency | null = g.mark
      ? MARKS.find((k) => new RegExp(`^(?:${k.re})$`, "i").test(g.mark!))!.currency
      : g.nnum !== undefined
        ? "NGN"
        : g.trail
          ? TRAILING.find((k) => new RegExp(`^(?:${k.re})$`, "i").test(g.trail!))!.currency
          : null;

    if (currency === null && !bareIsMoney(magnitude)) continue;

    out.push({ currency, minor: parseMagnitudeToMinor(magnitude), raw: m[0].trim(), index: m.index });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* What the message is denominated in                                         */
/* -------------------------------------------------------------------------- */

export type CurrencyRead =
  /** Nothing foreign in it. Naira, as every Balans message has been. */
  | { kind: "naira" }
  /** One foreign currency, and nothing contradicting it. */
  | { kind: "foreign"; currency: Foreign; amountMinor: number | null }
  /** Two currencies at once. The PRD's answer is to ask which. */
  | { kind: "mixed"; currencies: string[] }
  /** Real money, not money we take. */
  | { kind: "unsupported"; named: string };

const foreignIn = (tokens: AmountToken[]) =>
  tokens.filter(
    (t): t is AmountToken & { currency: Foreign } => t.currency !== null && isForeign(t.currency),
  );

/**
 * What currency this message is asking for.
 *
 * Only the *foreign* answer changes anything: naira is what everything
 * already does, so a message with no foreign mark in it is not this module's
 * business and falls straight through to the existing reader.
 *
 * The mixed case deserves its name. Somebody writing "$500 or 700k" has not
 * decided, and both readings are defensible, so there is no correct answer to
 * compute — only a question to ask. Guessing here would be picking a price
 * for somebody else's work.
 */
export function readCurrency(text: string): CurrencyRead {
  /*
   * Dates first. "due 2026-10-02" and "by 15/10" carry numbers that are not
   * money, and a stray year read as a naira amount turns a clean dollar
   * invoice into a mixed-currency question nobody asked.
   *
   * But the clause that gets cut is found by words — "by", "before", "within"
   * — and those words occur in sentences that are not dates. So if cutting
   * loses the foreign currency altogether, the cut was wrong and the whole
   * message is read instead. Trimming may remove a false clash; it may never
   * remove the mark that says this is a dollar invoice.
   */
  const trimmed = readAmounts(withoutDates(text));
  const tokens = foreignIn(trimmed).length ? trimmed : readAmounts(text);

  const bad = tokens.find((t) => t.unsupported);
  if (bad) return { kind: "unsupported", named: bad.unsupported! };

  const foreign = foreignIn(tokens);
  if (!foreign.length) return { kind: "naira" };

  const distinct = [...new Set(foreign.map((t) => t.currency))];
  if (distinct.length > 1) return { kind: "mixed", currencies: distinct.map((c) => INFO[c].many) };

  const nairaSide = tokens.filter((t) => t.currency === "NGN" || t.currency === null);
  if (nairaSide.length) {
    return { kind: "mixed", currencies: [INFO[foreign[0]!.currency].many, "naira"] };
  }

  /*
   * One currency, possibly several amounts: "invoice Acme $200 for the logo
   * and $300 for the site" is one invoice with two lines. The amount reported
   * here is only for the single-amount case; the line items are read by the
   * parser as they always were, and each one is in this currency.
   */
  return {
    kind: "foreign",
    currency: foreign[0]!.currency,
    amountMinor: foreign.length === 1 ? foreign[0]!.minor : null,
  };
}

/** The sentence with its due clause and any written dates taken off. */
function withoutDates(text: string): string {
  return text
    .replace(/[,;]?\s*\b(?:due|deadline|payable|by|before|not later than|within)\b.*$/is, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, "");
}

/* -------------------------------------------------------------------------- */
/* Saying it back                                                             */
/* -------------------------------------------------------------------------- */

/**
 * "$500.00", "£1,200.00", "₦663,500".
 *
 * Naira keeps the house style — whole figures, kobo only when there are any —
 * because that is how every existing message and document is written. Dollars
 * and pounds always show their cents, because a price in those currencies
 * with no decimal reads as approximate, and this one is exact.
 */
export function formatMoney(minor: number, currency: Currency): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  const cents = currency === "NGN" && part === 0 ? "" : `.${String(part).padStart(2, "0")}`;
  return `${minor < 0 ? "-" : ""}${INFO[currency].symbol}${whole.toLocaleString("en-NG")}${cents}`;
}
