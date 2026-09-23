// Nigerian shorthand amounts -> integer kobo (PRD F3).
// "350k" = 350,000; "1.2m" = 1,200,000; "5h" = 500; "2.5k" = 2,500;
// "₦350,000", "N350000" and "350000.50" also work. Returns null if unparseable.

const MULT: Record<string, number> = { h: 100, k: 1_000, m: 1_000_000 };

export function parseAmountToKobo(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/^(₦|ngn|n)\s*/, "").replace(/,/g, "").replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?)([hkm])?$/.exec(s);
  if (!m) return null;
  // Both groups are guaranteed by the regex above; group 2 is optional.
  const num = m[1]!;
  const suffix = m[2];
  // Work in integer thousandths to avoid float drift (e.g. 1.2 * 1e6).
  const [whole, frac = ""] = num.split(".") as [string, string?];
  if (frac.length > 6) return null;
  const scale = 10 ** frac.length;
  const units = BigInt(whole + frac); // value * scale
  // The regex only admits h, k or m, so the lookup always hits.
  const nairaTimesScale = units * BigInt(suffix ? MULT[suffix]! : 1);
  const koboTimesScale = nairaTimesScale * BigInt(100);
  if (koboTimesScale % BigInt(scale) !== BigInt(0)) return null; // finer than a kobo
  const kobo = Number(koboTimesScale / BigInt(scale));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/* -------------------------------------------------------------------------- */
/* What an invoice may be worth                                               */
/* -------------------------------------------------------------------------- */

/**
 * The smallest invoice worth sending.
 *
 * Not a preference. Fees are charged per payment and the Balans fee has a
 * floor of ₦100, so on the free plan a small invoice is eaten by its own
 * costs, and a very small one goes past that into nonsense:
 *
 *      ₦50   fees ₦100.75   the user receives  -₦50.75
 *     ₦100   fees ₦101.50   the user receives   -₦1.50
 *     ₦150   fees ₦102.25   the user receives   ₦47.75
 *     ₦500   fees ₦107.50   the user receives  ₦392.50   — 21.5% gone
 *   ₦1,000   fees ₦115.00   the user receives  ₦885.00   — 11.5% gone
 *
 * Below about ₦102 the split sent to the processor is negative, which is a
 * broken payment rather than a bad deal. So there has to be a floor, and the
 * only question is where.
 *
 * ₦1,000 is the first round figure at which the user keeps most of their
 * money, and it is well under any real piece of freelance work — nobody bills
 * ₦600 for a design. `amount-floor.test.ts` checks the relationship rather
 * than the number, so raising the minimum fee without moving this fails.
 */
export const MIN_INVOICE_KOBO = 1_000_00;

/**
 * The largest, which is a guard against a keyboard rather than a policy.
 *
 * The Amount box takes digits, and the difference between ₦5,000,000 and
 * ₦50,000,000 is one of them. A cap cannot catch the plausible typo — an
 * extra zero on ₦500,000 is still an invoice somebody might really send, and
 * the draft summary showing the figure in full is what catches that. What it
 * can catch is the implausible one, and ₦999,999,999,999 is not an invoice.
 *
 * Set well above any freelance or small-agency job so it never refuses real
 * work. It is not the true ceiling: what a client can actually transfer in
 * one go is whatever their bank and Monnify allow, which is unconfirmed — and
 * the payment plan is the answer to an invoice larger than one transfer.
 */
export const MAX_INVOICE_KOBO = 50_000_000_00;

/**
 * Whether a total can be invoiced, and why not when it cannot.
 *
 * On the total, never on a line. A ₦500 delivery charge inside a ₦50,000
 * invoice is a real line item, and refusing it would be refusing arithmetic
 * that is perfectly correct.
 */
export const invoiceableKobo = (totalKobo: number): "small" | "large" | null =>
  totalKobo < MIN_INVOICE_KOBO ? "small" : totalKobo > MAX_INVOICE_KOBO ? "large" : null;
