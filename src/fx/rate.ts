/**
 * The rate an invoice is priced at (International PRD section 6).
 *
 * Section 6 is four sentences and every one of them is a rule about failure:
 *
 *   - cache for a configurable period, default an hour;
 *   - if the rate cannot be fetched and the cache is older than a day, refuse
 *     to create foreign-currency invoices;
 *   - never guess a rate;
 *   - lock it at creation and never move it again.
 *
 * The third is the one that shapes this file. There is no fallback rate, no
 * last-known-good that quietly stretches to a week, no hard-coded 1,300 for
 * when the feed is down. `current()` returns null and the draft does not
 * happen, because a dollar invoice priced at a rate nobody can vouch for is
 * worse than no dollar invoice: the freelancer sends it, the client pays it,
 * and the money that arrives is whatever it turns out to be.
 *
 * A stale rate inside the day is different and is allowed. The feed publishes
 * daily anyway, so an hour-old figure and a nine-hour-old figure are usually
 * the same figure, and refusing to work because a provider is briefly down
 * would be refusing to work for no gain in accuracy.
 *
 * Nothing here decides what to *do* about a refusal. That is the draft's job,
 * and it has a sentence for it.
 */

import type { FastifyBaseLogger } from "fastify";

import type { Foreign } from "../../core/currency.ts";
import { isSaneRate } from "../../core/exchange.ts";
import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { sourceFor } from "./sources.ts";

export type Pair = `${Foreign}NGN`;
export const pairFor = (currency: Foreign): Pair => `${currency}NGN`;

/** A rate, and everything needed to defend it afterwards. */
export type Quote = {
  currency: Foreign;
  pair: Pair;
  rate: number;
  source: string;
  fetchedAt: Date;
};

type Row = { rate: string; source: string; fetched_at: Date };

const MINUTE = 60_000;

/** What the environment says, read on each call so a restart is the only ceremony. */
const settings = () => ({
  provider: env.FX_PROVIDER,
  cacheMs: env.FX_CACHE_MINUTES * MINUTE,
  staleMs: env.FX_STALE_MAX_HOURS * 60 * MINUTE,
  fixed: { USD: env.FX_FIXED_USDNGN, GBP: env.FX_FIXED_GBPNGN },
});

/** The newest rate we hold for this pair, however old. */
async function newest(pair: Pair): Promise<Quote | null> {
  const { rows } = await db().query<Row>(
    `SELECT rate, source, fetched_at FROM fx_rates
      WHERE pair = $1 ORDER BY fetched_at DESC LIMIT 1`,
    [pair],
  );
  const row = rows[0];
  if (!row) return null;

  const rate = Number(row.rate);
  // NUMERIC comes back as a string and a corrupt one would be NaN. A stored
  // rate gets the same scrutiny as a fetched one: the row was written by an
  // earlier version of this code, which is not the same as being trustworthy.
  if (!isSaneRate(rate)) return null;

  return {
    currency: pair.slice(0, 3) as Foreign,
    pair,
    rate,
    source: row.source,
    fetchedAt: row.fetched_at,
  };
}

async function store(pair: Pair, rate: number, source: string, raw: unknown): Promise<Date> {
  const { rows } = await db().query<{ fetched_at: Date }>(
    `INSERT INTO fx_rates (pair, rate, source, raw_json)
     VALUES ($1, $2, $3, $4) RETURNING fetched_at`,
    [pair, rate, source, raw === undefined ? null : JSON.stringify(raw)],
  );
  return rows[0]!.fetched_at;
}

/**
 * The rate to price an invoice at, or null if there isn't a defensible one.
 *
 * Null is a real answer and the caller must have words for it. It means the
 * provider could not be reached and nothing we hold is recent enough to
 * stand behind — the PRD's "refuse to create foreign-currency invoices and
 * tell the user to try again shortly".
 */
export async function current(
  currency: Foreign,
  opts: { fetchImpl?: typeof fetch; log?: FastifyBaseLogger; now?: Date } = {},
): Promise<Quote | null> {
  const { provider, cacheMs, staleMs, fixed } = settings();
  const pair = pairFor(currency);
  const now = opts.now ?? new Date();

  const held = await newest(pair);
  if (held && now.getTime() - held.fetchedAt.getTime() < cacheMs) return held;

  const source = sourceFor(provider, fixed);
  if (!source) {
    // Configuration naming a provider that does not exist. Loud, because the
    // alternative is silently pricing every international invoice off a
    // day-old cache and nobody noticing until the naira moves.
    opts.log?.error({ provider }, "fx: no such rate provider");
    return usable(held, now, staleMs, opts.log);
  }

  try {
    const quoted = await source.quote(currency, opts.fetchImpl ?? fetch);
    if (!quoted) {
      opts.log?.warn({ pair, source: source.name }, "fx: provider had no usable rate");
      return usable(held, now, staleMs, opts.log);
    }

    const fetchedAt = await store(pair, quoted.rate, source.name, quoted.raw);
    return { currency, pair, rate: quoted.rate, source: source.name, fetchedAt };
  } catch (err) {
    opts.log?.warn({ err, pair, source: source.name }, "fx: rate fetch failed");
    return usable(held, now, staleMs, opts.log);
  }
}

/**
 * Whether what we already hold is still worth pricing somebody's work with.
 *
 * The cutoff is a day. Inside it, a rate from a daily feed is the same rate;
 * outside it, the number has stopped being evidence about today and using it
 * would be the guess the PRD forbids.
 */
function usable(
  held: Quote | null,
  now: Date,
  staleMs: number,
  log?: FastifyBaseLogger,
): Quote | null {
  if (!held) return null;
  const age = now.getTime() - held.fetchedAt.getTime();
  if (age > staleMs) {
    log?.error({ pair: held.pair, ageHours: Math.round(age / 3_600_000) }, "fx: cache too old to use");
    return null;
  }
  log?.info({ pair: held.pair, ageMinutes: Math.round(age / MINUTE) }, "fx: serving a cached rate");
  return held;
}

/**
 * Warms the cache for both currencies.
 *
 * Called by the hourly job so that the first person to invoice abroad in the
 * morning is not the one waiting on somebody else's API — and so that a
 * provider outage shows up in the logs an hour before it shows up as a
 * freelancer being told they cannot send an invoice.
 */
export async function refreshAll(log: FastifyBaseLogger): Promise<void> {
  for (const currency of ["USD", "GBP"] as const) {
    const quote = await current(currency, { log });
    if (!quote) log.error({ currency }, "fx: no rate available");
  }
}
