/**
 * The banks in the setup form: Paystack's list, all of it, in two dropdowns.
 *
 * It was a hand-picked forty with an "Other" box for typing the rest, because
 * Monnify's 374 institutions were mostly routes nobody had heard of. Since 26
 * September 2026 the list is Paystack's (paystack-banks.json, refreshed with
 * `npm run banks`), every entry is a bank somebody can be paid into, and there
 * is no "Other": whatever bank a person has, they can pick it.
 *
 * Two dropdowns because one cannot hold them. WhatsApp takes 200 options in a
 * dropdown and Paystack lists 287, 190 of them microfinance banks. So:
 *
 *   Bank  — every commercial bank and fintech, the microfinance banks people
 *           actually know by name (Moniepoint, FairMoney and the like), and a
 *           last row, "Microfinance bank (below)".
 *   MFB   — every microfinance bank, for the rest.
 *
 * The second one is always on screen rather than appearing when the row is
 * chosen. Showing a field only for some answers needs a Switch or an If, and
 * a field that is sometimes not rendered is exactly how the invoice form died
 * with "Something went wrong" three times (see definitions.ts). An optional
 * box with a line saying when to use it has never broken anything.
 *
 * Values are Paystack's bank codes, so what comes back is exact and never has
 * to be matched by name.
 */

import { readFileSync } from "node:fs";

export type ListedBank = { name: string; code: string };

/** Paystack's list, as last refreshed. */
export const PAYSTACK_BANKS: readonly ListedBank[] = JSON.parse(
  readFileSync(new URL("./paystack-banks.json", import.meta.url), "utf8"),
) as ListedBank[];

/** The last row of the first dropdown: "it is in the second one". */
export const MFB_CHOICE = "mfb";

/** WhatsApp's ceiling on a dropdown without images. */
export const DROPDOWN_MAX = 200;

/** Meta's limit on an option's title. */
const TITLE_MAX = 30;

export const isMicrofinance = (name: string): boolean =>
  /micro[\s-]?finance|\bmfb\b/i.test(name);

/**
 * Microfinance banks people know by their brand and would look for among the
 * banks, not under "microfinance". In the first dropdown as well as the
 * second, so they are found wherever somebody looks.
 */
const KNOWN_MFB = new Set([
  "50515", // Moniepoint MFB
  "51318", // Fairmoney Microfinance Bank
  "566", // VFD Microfinance Bank
  "51310", // Sparkle Microfinance Bank
  "125", // Rubies MFB
]);

/**
 * A name that fits in thirty characters and still says which bank.
 *
 * Left alone when it already fits. Otherwise the short name Paystack puts in
 * brackets wins ("OPay Digital Services Limited (OPay)" is OPay), then the
 * company suffixes go, then "Microfinance Bank" becomes MFB, and only then is
 * anything cut.
 */
export function bankTitle(name: string): string {
  let n = name.replace(/\s+/g, " ").trim();
  if (n.length <= TITLE_MAX) return n;

  const bracket = /\(([^()]{3,})\)\s*$/.exec(n)?.[1]?.trim();
  if (bracket && bracket.length <= TITLE_MAX && !/formerly/i.test(bracket)) return bracket;

  n = n
    .replace(/\((?:formerly[^)]*)\)/gi, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\b(?:limited|ltd|plc|nigeria|company)\b\.?/gi, "")
    .replace(/micro[\s-]?finance bank/gi, "MFB")
    .replace(/\s+/g, " ")
    .trim();
  if (n.length > TITLE_MAX) n = n.replace(/\bUniversity\b/g, "Univ.");
  return n.length <= TITLE_MAX ? n : `${n.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Sorted by title, with any two titles that came out the same told apart. */
function options(banks: readonly ListedBank[]): { id: string; title: string }[] {
  // Once per code: Paystack lists at least one bank twice under two spellings
  // ("U and C MFB", "U AND C MFB"), and a dropdown value has to be unique.
  const once = [...new Map(banks.map((b) => [b.code, b] as const)).values()];
  const rows = once
    .map((b) => ({ id: b.code, title: bankTitle(b.name) }))
    .sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.title.toLowerCase(), (seen.get(r.title.toLowerCase()) ?? 0) + 1);
  return rows.map((r) =>
    (seen.get(r.title.toLowerCase()) ?? 0) > 1
      ? { ...r, title: `${r.title.slice(0, TITLE_MAX - r.id.length - 1).trimEnd()} ${r.id}` }
      : r,
  );
}

/** The first dropdown: banks, fintechs, the well-known MFBs, then the way to the rest. */
export const bankOptions = (banks: readonly ListedBank[] = PAYSTACK_BANKS): { id: string; title: string }[] => [
  ...options(banks.filter((b) => !isMicrofinance(b.name) || KNOWN_MFB.has(b.code))),
  { id: MFB_CHOICE, title: "Microfinance bank (below)" },
];

/** The second dropdown: every microfinance bank. */
export const mfbOptions = (banks: readonly ListedBank[] = PAYSTACK_BANKS): { id: string; title: string }[] =>
  options(banks.filter((b) => isMicrofinance(b.name)));
