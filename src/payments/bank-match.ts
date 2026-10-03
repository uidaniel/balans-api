/**
 * Which bank somebody means, from what they typed.
 *
 * Kept from the Monnify module when Monnify was retired (3 October 2026):
 * the matcher never depended on Monnify, only lived there.
 */

/**
 * Matches what someone typed to a bank.
 *
 * People write "GTBank", "gtb", "Guaranty Trust" and "Access Bank" for the same
 * handful of institutions, so an exact match is nearly useless. Tried in order:
 * exact, then a known alias, then a prefix, then a containment — and the
 * shortest name wins a tie, because "Access bank" should beat "Access bank
 * (Diamond)" for the word "access".
 */
const ALIASES: Record<string, string[]> = {
  gtbank: ["gtb", "gt bank", "guaranty trust", "guarantee trust", "gtco"],
  "access bank": ["access"],
  "united bank for africa": ["uba"],
  "first bank of nigeria": ["first bank", "firstbank", "fbn"],
  "zenith bank": ["zenith"],
  "fidelity bank": ["fidelity"],
  "union bank of nigeria": ["union bank", "union"],
  "sterling bank": ["sterling"],
  "stanbic ibtc bank": ["stanbic", "ibtc"],
  "ecobank nigeria": ["ecobank", "eco bank"],
  "wema bank": ["wema"],
  "polaris bank": ["polaris"],
  "keystone bank": ["keystone"],
  "unity bank": ["unity"],
  "moniepoint mfb": ["moniepoint", "monie point"],
  "kuda microfinance bank": ["kuda"],
  "opay digital services limited": ["opay"],
  "palmpay": ["palm pay"],
  // Monnify lists the bank as "First City Monument Bank Plc" and a separate
  // wallet as "FCMB MOBILE". Without this, the abbreviation everybody uses
  // matches only the wallet.
  "first city monument bank": ["fcmb", "first city monument"],
  "jaiz bank": ["jaiz"],
  "providus bank": ["providus"],
  "titan bank": ["titan"],
  "globus bank": ["globus"],
  "taj bank": ["taj"],
  "lotus bank": ["lotus"],
  "suntrust bank": ["suntrust", "sun trust"],
  "premium trust bank": ["premium trust", "premiumtrust"],
  "parallex bank": ["parallex"],
  "citibank nigeria": ["citibank", "citi bank", "citi"],
  "heritage bank": ["heritage"],
  "standard chartered bank": ["standard chartered", "stanchart"],
  "vfd microfinance bank": ["vfd"],
  "paga": ["paga"],
};

/**
 * A bank that can actually receive a settlement.
 *
 * Nigeria's three-digit CBN codes belong to licensed banks. The longer codes
 * are NIP-only routes: mobile wallets, agent networks and some microfinance
 * banks. Both resolve an account name perfectly well, which is the trap — a
 * wallet passes every check we make and then fails at subaccount creation,
 * after the user has confirmed their name and thinks they are done.
 *
 * So when several entries match one name, the licensed bank wins. "OPAY 3"
 * and "PAYCOM (OPAY)" are the same institution; only one of them settles.
 */
const isLicensedBank = (b: { code: string }): boolean => /^\d{3}$/.test(b.code);

export function matchBank<B extends { name: string; code: string }>(query: string, banks: B[]): B | null {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  /** Licensed bank first, then the plainer name. */
  const best = (a: B, b: B) =>
    Number(isLicensedBank(b)) - Number(isLicensedBank(a)) || a.name.length - b.name.length;

  // Aliases before exact matches. An alias is a curated statement about what
  // people mean; an exact match is a coincidence of spelling, and Monnify's
  // list contains both "Globus" (a NIP route) and "Globus Bank" (the bank).
  // Someone typing "globus" means the bank.
  for (const [canonical, alts] of Object.entries(ALIASES)) {
    if (!alts.includes(q) && q !== canonical) continue;
    // Every spelling of this bank, so "opay" finds "PAYCOM (OPAY)" too — the
    // one that does not start with the word being searched for.
    const needles = [canonical, ...alts];
    const hits = banks.filter((b) => {
      const name = norm(b.name);
      return needles.some((needle) => name.includes(needle));
    });
    if (hits.length) return hits.sort(best)[0]!;
  }

  const exact = banks.filter((b) => norm(b.name) === q);
  if (exact.length) return exact.sort(best)[0]!;

  const prefix = banks.filter((b) => norm(b.name).startsWith(q));
  if (prefix.length) return prefix.sort(best)[0]!;

  const contains = banks.filter((b) => norm(b.name).includes(q));
  if (contains.length) return contains.sort(best)[0]!;

  // Last resort, the other direction: a bank name sitting inside a sentence.
  //
  // The state machine hands over whatever was left after the account number was
  // removed, so "my bank is Zenith," arrives whole. Everything above asks "is
  // this query a bank name?"; this asks "is there a bank name in this query?".
  //
  // Whole words only, or "access" matches inside "accessory". The longest
  // needle wins, so "first bank" beats the bare word "bank".
  const words = new Set(q.split(" "));
  const phraseIn = (needle: string) =>
    needle.includes(" ") ? q.includes(needle) : words.has(needle);

  let found: { bank: B; needle: number } | null = null;
  for (const bank of banks) {
    const name = norm(bank.name);
    for (const needle of [name, ...(ALIASES[name] ?? [])]) {
      if (needle.length < 3 || !phraseIn(needle)) continue;
      const better =
        !found ||
        needle.length > found.needle ||
        (needle.length === found.needle && isLicensedBank(bank) && !isLicensedBank(found.bank)) ||
        (needle.length === found.needle &&
          isLicensedBank(bank) === isLicensedBank(found.bank) &&
          bank.name.length < found.bank.name.length);
      if (better) found = { bank, needle: needle.length };
    }
  }
  return found?.bank ?? null;
}
