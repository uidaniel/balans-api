/**
 * Turning a foreign price into the naira that will actually be charged
 * (International PRD sections 2 and 6).
 *
 * The thing to hold on to is that nobody is ever charged in dollars. Paystack
 * charges international cards in naira, the client's own bank does the
 * conversion at whatever rate it uses, and the money that arrives is naira.
 * So "$500" is a *label*: the price the freelancer and their client agreed,
 * shown on the invoice so it is recognisable, converted once into the figure
 * the card is actually charged.
 *
 * Which makes the conversion a commitment rather than a display. It is locked
 * at the moment the invoice is created and it does not move again, because an
 * invoice whose price changed between being sent and being paid is not an
 * invoice. Everything after that — the fee, the gross-up, what settles — is
 * ordinary naira arithmetic on the figure this file produces, and the rest of
 * the system never needs to know a dollar was involved.
 *
 * Nothing here fetches anything. A rate arrives as a number with a source and
 * a timestamp attached (see `src/fx/rate.ts`); this file only spends it.
 */

/** NGN per one unit of the foreign currency. 1327.5 means ₦1,327.50 to $1. */
export type Rate = number;

/**
 * What a rate is allowed to be.
 *
 * Not a forecast — a sanity check on somebody else's JSON. A feed that
 * returns 0, or null coerced to 0, or a rate quoted the other way round
 * (0.00075 dollars to the naira) would each produce an invoice for nothing,
 * and an invoice for nothing is one a client can settle for nothing. The
 * bounds are deliberately wide: they are there to catch a broken response,
 * not to have an opinion about the naira.
 */
const MIN_RATE = 50;
const MAX_RATE = 100_000;

export const isSaneRate = (rate: unknown): rate is Rate =>
  typeof rate === "number" && Number.isFinite(rate) && rate > MIN_RATE && rate < MAX_RATE;

/**
 * The naira charge for a foreign amount, rounded to the nearest naira.
 *
 * Both currencies keep two minor digits, so cents times a naira-per-dollar
 * rate is kobo directly: 50,000 cents at 1,327 is 66,350,000 kobo, which is
 * ₦663,500. No division, nothing to lose.
 *
 * Then rounded to a whole naira, which section 6 asks for and which is worth
 * doing for a reason beyond tidiness. This figure is typed into a bank app by
 * a human being on some occasions and matched to the kobo on all of them, and
 * "₦663,436.53" is three more chances to get it wrong than "₦663,437".
 *
 * Rounds to nearest rather than up. Up would be a margin, and a margin that
 * nobody chose and nobody is told about is not a margin, it is a thumb on the
 * scale.
 */
export function nairaKoboFor(amountMinor: number, rate: Rate): number {
  if (!isSaneRate(rate)) throw new RangeError(`implausible rate: ${rate}`);
  if (amountMinor <= 0) return 0;
  const exact = amountMinor * rate;
  if (!Number.isSafeInteger(Math.round(exact))) {
    throw new RangeError(`amount too large to convert: ${amountMinor}`);
  }
  return Math.round(exact / 100) * 100;
}

/**
 * The rate implied by a locked charge, for saying it back.
 *
 * A draft quotes "today's rate ₦1,327/$", and that sentence has to agree with
 * the figure beside it or it is worse than saying nothing. Recomputing it
 * from the two numbers on the invoice means it always does, including after
 * the rounding above and for a historical invoice whose rate has long since
 * stopped being today's.
 */
export const impliedRate = (chargeKobo: number, amountMinor: number): number =>
  amountMinor <= 0 ? 0 : chargeKobo / amountMinor;
