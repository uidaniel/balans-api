/**
 * Where a naira exchange rate comes from (International PRD section 6).
 *
 * One interface, several providers, chosen by configuration and *recorded on
 * every invoice*. That last part is what makes this a module rather than a
 * function: the day the source changes, every invoice already sent has to
 * keep being able to say which rate it used and who said so. A number with no
 * provenance is not a rate, it is a claim.
 *
 * None of these is blessed yet. Section 13 will not let international
 * invoicing go live until the chosen provider is live and recorded on a real
 * test invoice, and the founder's decision about *which* is a commercial one
 * — an official reference rate and a market rate are different numbers, and
 * the gap between them is somebody's money.
 */

import type { Foreign } from "../../core/currency.ts";
import { isSaneRate } from "../../core/exchange.ts";

export type Quoted = {
  /** Naira per one unit of the foreign currency. */
  rate: number;
  /** The provider's whole response, kept for the day one of them starts lying. */
  raw: unknown;
};

export type Source = {
  name: string;
  /** Null when the provider answered but had nothing usable to say. */
  quote(currency: Foreign, fetchImpl: typeof fetch): Promise<Quoted | null>;
};

/**
 * exchangerate-api's free endpoint. No key, updated once a day.
 *
 * Chosen to build against because it needs no account and its USD/NGN agrees
 * with the PRD's worked example to within a naira, which is the only external
 * check available before a real payment settles. It is a *daily reference*
 * rate: good enough to price an invoice that will be paid within days, not a
 * live market feed, and it should be treated as a placeholder for whatever
 * the business eventually signs up to.
 */
const openErApi: Source = {
  name: "open.er-api.com",
  async quote(currency, fetchImpl) {
    const res = await fetchImpl(`https://open.er-api.com/v6/latest/${currency}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const body = (await res.json().catch(() => null)) as {
      result?: string;
      rates?: Record<string, unknown>;
    } | null;

    if (!body || body.result !== "success") return null;
    const rate = body.rates?.NGN;
    // A provider that answers 200 with a missing or nonsensical figure is the
    // case this exists to survive. `isSaneRate` is the only thing between a
    // null coerced to zero and an invoice priced at nothing.
    return isSaneRate(rate) ? { rate, raw: body } : null;
  },
};

/**
 * A rate typed into the environment by hand.
 *
 * Two jobs. It is how the sandbox runs without depending on somebody else's
 * uptime, and it is the lever to pull the morning a feed goes wrong or the
 * naira moves faster than a daily rate can follow: set the number, restart,
 * and every invoice from then on is priced at what the founder decided rather
 * than at what a free API last managed to publish.
 */
const fixed = (rates: Partial<Record<Foreign, number>>): Source => ({
  name: "fixed",
  async quote(currency) {
    const rate = rates[currency];
    return isSaneRate(rate) ? { rate, raw: { source: "fixed", currency, rate } } : null;
  },
});

export function sourceFor(
  provider: string,
  fixedRates: Partial<Record<Foreign, number>>,
): Source | null {
  if (provider === "fixed") return fixed(fixedRates);
  if (provider === openErApi.name || provider === "open-er-api") return openErApi;
  return null;
}

export const SOURCE_NAMES = ["open-er-api", "fixed"] as const;
