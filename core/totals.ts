/**
 * Document totals (PRD F6, F7).
 *
 * All integer kobo, all BigInt in the middle. The temptation is to write
 * `Math.round(qty * unit)` and move on; at 1.2m naira with a fractional
 * quantity that is already in the range where a double stops being exact, and
 * a kobo that appears from nowhere on an invoice is a kobo somebody has to
 * explain to a client.
 *
 * Rounding is half-up, the way an invoice rounds. Banker's rounding is more
 * defensible statistically and completely indefensible to a freelancer asking
 * why 7.5% of 350,000 came to a different number than their calculator said.
 */

export type Line = {
  description: string;
  /** Up to three decimal places, matching line_items.qty NUMERIC(12,3). */
  qty: number;
  unitAmountKobo: number;
};

export type Totals = {
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  /** Each line's own total, in the order given. */
  lineTotalsKobo: number[];
};

const QTY_SCALE = 1000n;

/** Half-up division of BigInts, for a positive denominator. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const twice = numerator * 2n + (numerator < 0n ? -denominator : denominator);
  return twice / (denominator * 2n);
}

const toSafe = (v: bigint): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`amount out of range: ${v}`);
  return n;
};

/** One line: quantity times unit price, rounded to the kobo. */
export function lineTotal(qty: number, unitAmountKobo: number): number {
  if (!Number.isFinite(qty) || qty < 0) throw new RangeError(`bad quantity: ${qty}`);
  if (!Number.isSafeInteger(unitAmountKobo) || unitAmountKobo < 0) {
    throw new RangeError(`bad unit amount: ${unitAmountKobo}`);
  }
  const milli = BigInt(Math.round(qty * 1000));
  return toSafe(divRound(milli * BigInt(unitAmountKobo), QTY_SCALE));
}

/**
 * VAT on a subtotal. 7.5% is Nigeria's rate and the default when someone says
 * "plus VAT" (F6), but the percentage is always passed in so the rate lives in
 * one place and changing it is a config edit.
 */
export function vatOn(subtotalKobo: number, percent: number): number {
  if (percent <= 0) return 0;
  if (!Number.isFinite(percent) || percent > 100) throw new RangeError(`bad VAT rate: ${percent}`);
  // The rate has at most one decimal, so work in tenths of a percent.
  const tenths = BigInt(Math.round(percent * 10));
  return toSafe(divRound(BigInt(subtotalKobo) * tenths, 1000n));
}

export function totalsFor(lines: Line[], vatPercent: number | null): Totals {
  const lineTotalsKobo = lines.map((l) => lineTotal(l.qty, l.unitAmountKobo));
  const subtotalKobo = lineTotalsKobo.reduce((t, n) => t + n, 0);
  const vatKobo = vatPercent ? vatOn(subtotalKobo, vatPercent) : 0;
  return { subtotalKobo, vatKobo, totalKobo: subtotalKobo + vatKobo, lineTotalsKobo };
}

/* -------------------------------------------------------------------------- */
/* Deposits and milestones (F7)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Splits a total into parts that sum to it exactly.
 *
 * F7: "Parts must sum exactly to the total; rounding remainder goes to the
 * last part." Every part but the last is rounded down and the last takes what
 * is left, so the arithmetic closes by construction rather than by hoping the
 * roundings cancel. Somebody paying two halves of an odd number of kobo pays
 * the whole thing.
 */
export function splitInto(totalKobo: number, percents: number[]): number[] {
  if (!percents.length) return [totalKobo];
  if (!Number.isSafeInteger(totalKobo) || totalKobo < 0) {
    throw new RangeError(`bad total: ${totalKobo}`);
  }

  const sum = percents.reduce((t, p) => t + p, 0);
  if (Math.abs(sum - 100) > 0.001) {
    throw new RangeError(`parts add up to ${sum}%, not 100%`);
  }

  const total = BigInt(totalKobo);
  const parts: number[] = [];
  let taken = 0n;

  for (const percent of percents.slice(0, -1)) {
    // Floor, not round: rounding every part up can overshoot the total, and
    // then the last part has to be negative to close it.
    const part = (total * BigInt(Math.round(percent * 100))) / 10_000n;
    parts.push(toSafe(part));
    taken += part;
  }

  parts.push(toSafe(total - taken));
  return parts;
}

/** "50% deposit" as F7 writes it: a deposit and the balance. */
export const depositSplit = (totalKobo: number, depositPercent: number): [number, number] => {
  const [deposit, balance] = splitInto(totalKobo, [depositPercent, 100 - depositPercent]);
  return [deposit!, balance!];
};

/* -------------------------------------------------------------------------- */

/** Naira, grouped, for anything a person reads. "350,000" not "35000000". */
export function formatNaira(kobo: number): string {
  const negative = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const remainder = abs % 100;
  const grouped = naira.toLocaleString("en-US");
  const body = remainder ? `${grouped}.${String(remainder).padStart(2, "0")}` : grouped;
  return `${negative ? "-" : ""}₦${body}`;
}
