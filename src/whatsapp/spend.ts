/**
 * What WhatsApp actually charged, as Meta reports it (30 October 2026).
 *
 * The admin used to show the sum of a fixed per-message guess. Meta's pricing
 * analytics say what was billed, by day, category (marketing, utility,
 * authentication, service) and type (regular, or free inside the service
 * window, or free from an ad). This keeps the last few weeks of that in
 * `whatsapp_spend` (migration 0051), which the admin reads.
 *
 * Meta reports in the WhatsApp account's own currency. Naira is kept beside
 * it at the day's rate from fx/rate.ts; with no rate to stand behind, the
 * naira is left empty and the admin says so, rather than inventing one.
 *
 * Synced from the hourly jobs, at most every few hours: the figures settle a
 * day or so after the fact, so re-reading the recent days is how a late
 * correction from Meta gets in.
 */

import type { FastifyBaseLogger } from "fastify";

import { FOREIGN, type Foreign } from "../../core/currency.ts";
import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { current } from "../fx/rate.ts";

/** How far back each sync re-reads. Thirty days for the admin, and a margin. */
const DAYS = 35;
const EVERY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SpendRow = {
  /** The UTC day Meta reports it under, YYYY-MM-DD. */
  day: string;
  category: string;
  type: string;
  country: string;
  volume: number;
  cost: number;
};

/**
 * Pricing analytics arrived with per-message pricing (Graph v23). An older
 * configured version is raised for this one call rather than for every call
 * the product makes.
 */
function graphVersion(): string {
  const v = Number(env.WA_GRAPH_VERSION.replace(/^v/, ""));
  return Number.isFinite(v) && v >= 23 ? env.WA_GRAPH_VERSION : "v23.0";
}

export function spendUrl(waba: string, from: Date, to: Date): string {
  const s = Math.floor(from.getTime() / 1000);
  const e = Math.floor(to.getTime() / 1000);
  const fields =
    `currency,pricing_analytics.start(${s}).end(${e}).granularity(DAILY)` +
    `.dimensions(["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])`;
  return `https://graph.facebook.com/${graphVersion()}/${waba}?fields=${encodeURIComponent(fields)}`;
}

/**
 * Meta's answer, flattened to one row per day, category, type and country.
 *
 * Read defensively: a missing number is zero, a point without a start is
 * dropped, and two points for the same key are added together.
 */
export function parseSpend(body: unknown): { currency: string | null; rows: SpendRow[] } {
  const root = (body ?? {}) as {
    currency?: unknown;
    pricing_analytics?: { data?: { data_points?: unknown[] }[] };
  };
  const byKey = new Map<string, SpendRow>();
  for (const group of root.pricing_analytics?.data ?? []) {
    for (const raw of group.data_points ?? []) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const start = Number(p.start);
      if (!Number.isFinite(start) || start <= 0) continue;
      const row: SpendRow = {
        day: new Date(start * 1000).toISOString().slice(0, 10),
        category: String(p.pricing_category ?? "unknown").toLowerCase(),
        type: String(p.pricing_type ?? "unknown").toLowerCase(),
        country: String(p.country ?? ""),
        volume: Number(p.volume) || 0,
        cost: Number(p.cost) || 0,
      };
      const key = `${row.day}|${row.category}|${row.type}|${row.country}`;
      const had = byKey.get(key);
      if (had) {
        had.volume += row.volume;
        had.cost += row.cost;
      } else byKey.set(key, row);
    }
  }
  return {
    currency: typeof root.currency === "string" ? root.currency.toUpperCase() : null,
    rows: [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Naira kobo for a cost in `currency` at `rate`, or null when it cannot be said. */
export function toKobo(cost: number, currency: string, rate: number | null): number | null {
  if (currency === "NGN") return Math.round(cost * 100);
  if (rate === null || !(rate > 0)) return null;
  return Math.round(cost * rate * 100);
}

let lastTry = 0;

/** Re-reads the last few weeks from Meta, if it has been a while. Never throws. */
export async function syncWhatsAppSpend(
  log: FastifyBaseLogger,
  opts: { force?: boolean; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<number> {
  if (!env.WA_ACCESS_TOKEN || !env.WA_BUSINESS_ACCOUNT_ID) return 0;
  const now = opts.now ?? new Date();
  if (!opts.force && now.getTime() - lastTry < EVERY_MS) return 0;
  lastTry = now.getTime();

  // Whole UTC days, which is how Meta buckets them.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (DAYS - 1) * DAY_MS);
  const to = new Date(today + DAY_MS - 1000);

  try {
    const res = await (opts.fetchImpl ?? fetch)(spendUrl(env.WA_BUSINESS_ACCOUNT_ID, from, to), {
      headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok || !body) {
      log.warn({ status: res.status, error: body?.error?.message }, "whatsapp spend: Meta would not say");
      return 0;
    }

    const { currency, rows } = parseSpend(body);
    if (!currency) {
      log.warn("whatsapp spend: Meta gave no currency for the account");
      return 0;
    }
    const rate =
      currency === "NGN" || !(FOREIGN as readonly string[]).includes(currency)
        ? null
        : ((await current(currency as Foreign, { log }))?.rate ?? null);
    if (currency !== "NGN" && rate === null) {
      log.warn({ currency }, "whatsapp spend: no naira rate today; kept in the account's currency only");
    }

    // Replace the window as one piece, so a category Meta stops reporting for
    // a day does not linger beside the corrected figures.
    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM whatsapp_spend WHERE day >= $1::date`, [from.toISOString().slice(0, 10)]);
      for (const r of rows) {
        await client.query(
          `INSERT INTO whatsapp_spend
             (day, pricing_category, pricing_type, country, volume, cost, currency, cost_kobo, fx_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.day, r.category, r.type, r.country, r.volume, r.cost, currency, toKobo(r.cost, currency, rate), rate],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    log.info({ rows: rows.length, currency, rate }, "whatsapp spend synced from Meta");
    return rows.length;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "whatsapp spend: sync failed");
    return 0;
  }
}
