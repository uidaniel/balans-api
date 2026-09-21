/**
 * The fee engine (PRD section 9).
 *
 * Two fees come out of every payment, and they are not ours to blur:
 *
 *   - The *processor's* fee, which the payment provider takes. The bearer is
 *     always the user's subaccount, so it comes out of their share and never
 *     out of ours. That is section 9's rule, and it is also the only honest
 *     arrangement: we are not the ones moving the money.
 *   - *Balans's* fee, a capped percentage, which is the business.
 *
 * Both are computed here, in integer kobo, from configuration. Nothing in this
 * file reads the environment or the clock, so every number below is a pure
 * function of its inputs and every worked example in the PRD is a test.
 *
 * NOTE ON RATES. Section 9's numbers describe Paystack, which the PRD was
 * written against. Balans now settles through Monnify, whose schedule differs
 * — so the processor rates are configuration, defaulted to the documented
 * figures and overridable without a deploy. They must be confirmed against the
 * live Monnify contract before real money moves.
 */

export type ProcessorRates = {
  /** Basis points. 150 = 1.5%. */
  percentBps: number;
  /** A flat charge on top, in kobo. */
  flatKobo: number;
  /** The flat charge is waived on transactions below this, in kobo. */
  flatWaivedBelowKobo: number;
  /** The most the processor will take, in kobo. */
  capKobo: number;
};

export type BalansRates = {
  percentBps: number;
  minKobo: number;
  capKobo: number;
};

/** Section 9's defaults, as documented. Overridden by the `config` table. */
export const DEFAULT_PROCESSOR: ProcessorRates = {
  percentBps: 150,
  flatKobo: 100_00,
  flatWaivedBelowKobo: 2_500_00,
  capKobo: 2_000_00,
};

/*
 * Every fraction of a kobo is rounded in the user's favour.
 *
 * Section 9's own worked example fixes the convention: 1.5% of 50,862.95 is
 * 762.94425, and the PRD writes the fee as 862.95 rather than 862.94. It
 * rounds the processor's cut up. That is the conservative reading — assume
 * the processor takes the larger amount — and it is why a gross-up computed
 * this way never leaves the user a kobo short.
 *
 * Our own fee rounds the other way, down, for the same reason pointing the
 * other direction: the sub-kobo remainder is not worth having and it is not
 * ours to round towards ourselves.
 */
const ceilPct = (amountKobo: number, bps: number): number =>
  Number((BigInt(amountKobo) * BigInt(bps) + 9_999n) / 10_000n);

const floorPct = (amountKobo: number, bps: number): number =>
  Number((BigInt(amountKobo) * BigInt(bps)) / 10_000n);

/**
 * What the payment provider takes.
 *
 * The flat charge is waived under the threshold, which is why a ₦2,000
 * invoice costs 30 and a ₦20,000 one costs 400 rather than 300.
 */
export function processorFee(amountKobo: number, rates = DEFAULT_PROCESSOR): number {
  if (amountKobo <= 0) return 0;
  const flat = amountKobo < rates.flatWaivedBelowKobo ? 0 : rates.flatKobo;
  return Math.min(ceilPct(amountKobo, rates.percentBps) + flat, rates.capKobo);
}

/**
 * What Balans takes.
 *
 * "Computed on the invoice amount excluding any fee passed to the client" —
 * so a grossed-up total does not quietly increase our own cut. The referral
 * reward halves it *after* the caps, which is worth stating because halving
 * before the cap would give a different answer on every large invoice.
 */
export function balansFee(
  amountKobo: number,
  rates: BalansRates,
  opts: { referralHalved?: boolean } = {},
): number {
  if (amountKobo <= 0) return 0;
  const raw = floorPct(amountKobo, rates.percentBps);
  const capped = Math.min(Math.max(raw, rates.minKobo), rates.capKobo);
  return opts.referralHalved ? Math.floor(capped / 2) : capped;
}

/* -------------------------------------------------------------------------- */

export type Settlement = {
  /** What the client is charged. Equals the invoice unless fees are passed on. */
  clientPaysKobo: number;
  processorFeeKobo: number;
  balansFeeKobo: number;
  /** What lands in the user's bank. */
  userReceivesKobo: number;
};

/**
 * Who ends up with what.
 *
 * With `passToClient` off, the user absorbs both fees out of the invoice
 * amount. With it on, the client's total is grossed up so the user receives
 * "the invoice amount minus only the Balans fee" (section 9) — so what gets
 * passed on is the *processor's* fee, and ours never moves. A user cannot
 * charge their client for what Balans costs them, which is the right way
 * round: the client agreed to the invoice, not to our pricing.
 */
export function settle(
  invoiceKobo: number,
  balans: BalansRates,
  opts: {
    passToClient?: boolean;
    referralHalved?: boolean;
    processor?: ProcessorRates;
    /** Added to our share when the user pays Pro by deduction (section 9). */
    subscriptionDeductionKobo?: number;
  } = {},
): Settlement {
  const rates = opts.processor ?? DEFAULT_PROCESSOR;
  const ours =
    balansFee(invoiceKobo, balans, { referralHalved: opts.referralHalved }) +
    (opts.subscriptionDeductionKobo ?? 0);

  const clientPaysKobo = opts.passToClient ? grossUp(invoiceKobo, rates) : invoiceKobo;
  const processorFeeKobo = processorFee(clientPaysKobo, rates);

  return {
    clientPaysKobo,
    processorFeeKobo,
    balansFeeKobo: ours,
    userReceivesKobo: clientPaysKobo - processorFeeKobo - ours,
  };
}

/**
 * The smallest total that still clears the invoice after the processor's cut.
 *
 * Section 9 gives the algebra, then adds step 4: "verify by computing the fee
 * on T; adjust by one kobo if rounding leaves the user short." That last step
 * is the whole thing. The closed form is only an estimate — it cannot account
 * for the flat charge appearing at a threshold, the cap cutting in, or which
 * way the rounding falls — so the estimate is a starting point and the loop is
 * what makes the answer true. Being a kobo over costs the client nothing they
 * would notice; being a kobo under means the user did not get paid in full.
 */
export function grossUp(invoiceKobo: number, rates = DEFAULT_PROCESSOR): number {
  if (invoiceKobo <= 0) return 0;

  const denominator = 10_000 - rates.percentBps;

  // Try it without the flat charge first, in case the total stays under the
  // threshold where it is waived.
  const bare = Math.ceil((invoiceKobo * 10_000) / denominator);
  let estimate =
    bare < rates.flatWaivedBelowKobo
      ? bare
      : Math.ceil(((invoiceKobo + rates.flatKobo) * 10_000) / denominator);

  // Past the cap the fee stops growing, so the total is simply the amount plus
  // the cap. Without this the estimate overshoots badly on large invoices.
  if (processorFee(estimate, rates) >= rates.capKobo) {
    estimate = invoiceKobo + rates.capKobo;
  }

  // Walk up until the invoice is covered. In practice this runs nought or once;
  // the bound is there so a bad rate table cannot spin forever.
  for (let total = estimate, i = 0; i < 1000; total++, i++) {
    if (total - processorFee(total, rates) >= invoiceKobo) return total;
  }

  throw new RangeError(`cannot gross up ${invoiceKobo} with these rates`);
}
