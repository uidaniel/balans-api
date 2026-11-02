/**
 * Whether two official names are the same person or the same business
 * (20 October 2026).
 *
 * The NIN record and the bank both spell a name their own way: "UWAK DANIEL
 * INIOBONG" at one, "Daniel Iniobong Uwak" at the other, a middle name at one
 * and not the other. So a name is a set of words, and it matches when the
 * first name and surname are both there, in any order. Middle names may be
 * missing either side. Nothing fuzzier than that: a near miss goes to a
 * person, never through.
 */

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "ENGR", "CHIEF", "PROF", "ALHAJI", "ALHAJA", "PASTOR", "BARR"]);

/** Upper-case words, letters only, titles dropped. */
export function words(name: string | null | undefined): string[] {
  return (name ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !TITLES.has(w));
}

export type Person = { first: string; middle?: string | null; last: string };

/** The person's first name and surname are both in the account's name. */
export function personMatchesAccount(p: Person, accountName: string): boolean {
  const account = new Set(words(accountName));
  const first = words(p.first);
  const last = words(p.last);
  if (!first.length || !last.length) return false;
  return first.every((w) => account.has(w)) && last.every((w) => account.has(w));
}

/** The same person, in either order, as an affiliate on the CAC record. */
export function samePerson(a: Person, b: { first?: string | null; last?: string | null; middle?: string | null }): boolean {
  const theirs = new Set([...words(b.first), ...words(b.middle), ...words(b.last)]);
  const first = words(a.first);
  const last = words(a.last);
  return first.length > 0 && last.length > 0 && first.every((w) => theirs.has(w)) && last.every((w) => theirs.has(w));
}

/** The legal-form words a bank and the register write differently. */
const FORMS = new Set(["LIMITED", "LTD", "PLC", "NIG", "NIGERIA", "COMPANY", "CO", "THE", "AND"]);

const businessWords = (name: string): string[] => words(name.replace(/&/g, " AND ")).filter((w) => !FORMS.has(w));

/**
 * A bank's name for the account is the register's name for the business.
 *
 * Banks cut long names short, so the account's words only have to all be in
 * the registered name, and there must be at least two of them, or one that
 * is the whole registered name: "CODES" alone matches nothing.
 */
export function businessMatchesAccount(registered: string, accountName: string): boolean {
  const reg = businessWords(registered);
  const acc = businessWords(accountName);
  if (!reg.length || !acc.length) return false;
  const regSet = new Set(reg);
  if (!acc.every((w) => regSet.has(w))) return false;
  return acc.length >= 2 || reg.length === 1;
}
