/**
 * What Pro costs this person, and what Paystack charges for it.
 *
 * In Nigeria: the naira price in config, as it always was. Outside Nigeria:
 * the local price agreed on 4 October 2026 (core/pro-price.ts) — "£4 a
 * month" — charged through the same Paystack checkout as its naira value at
 * today's rate, because the Paystack account charges in naira. The card's
 * bank does the converting, so the chat says so before anybody pays.
 *
 * Should no rate be had, the naira price stands in: Pro is never priced from
 * a guessed rate, and a naira price is still a true one.
 */

import type { FastifyBaseLogger } from "fastify";

import { formatMoney } from "../../core/currency.ts";
import { nairaKoboFor } from "../../core/exchange.ts";
import { proPriceAbroad } from "../../core/pro-price.ts";
import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { db } from "../db/pool.ts";
import { current as currentRate } from "../fx/rate.ts";

export type ProTerm = "month" | "year";

export type ProPrice = {
  /** What the person reads: "₦3,000", "£4", "KSh 400". */
  label: string;
  /** What the Paystack checkout charges, in kobo. */
  chargeKobo: number;
  /** Priced in another currency and charged in naira. */
  abroad: boolean;
  /** Set only on a year (9 October 2026); a price without it is a month. */
  term?: "year";
};

/** How many months a price buys. */
export const monthsOf = (p: ProPrice): number => (p.term === "year" ? 12 : 1);

/** The naira price, for Nigeria and for anywhere a rate cannot be had. */
export const NAIRA_PRICE: ProPrice = {
  label: formatNaira(defaults.plans.pro.priceKobo),
  chargeKobo: defaults.plans.pro.priceKobo,
  abroad: false,
};

/** A year in Nigeria: twelve months for the price of ten. */
export const NAIRA_YEAR_PRICE: ProPrice = {
  label: formatNaira(defaults.plans.pro.yearPriceKobo),
  chargeKobo: defaults.plans.pro.yearPriceKobo,
  abroad: false,
  term: "year",
};

/** "£4" rather than "£4.00": a round price reads as one. */
const label = (minor: number, currency: Parameters<typeof formatMoney>[1]): string => {
  const full = formatMoney(minor, currency);
  return minor % 100 === 0 ? full.replace(/\.00$/, "") : full;
};

export async function proPriceForPhone(
  phone: string | null | undefined,
  log?: FastifyBaseLogger,
  rateOf: typeof currentRate = currentRate,
  term: ProTerm = "month",
): Promise<ProPrice> {
  const year = term === "year";
  const naira = year ? NAIRA_YEAR_PRICE : NAIRA_PRICE;
  const local = proPriceAbroad(phone);
  if (!local || local.currency === "NGN") return naira;
  const rate = await rateOf(local.currency, log ? { log } : {}).catch(() => null);
  if (!rate) {
    log?.warn({ currency: local.currency }, "no rate for a Pro price abroad; using the naira price");
    return naira;
  }
  // Abroad too, a year is ten months' price.
  const minor = year ? local.minor * 10 : local.minor;
  return {
    label: label(minor, local.currency),
    chargeKobo: nairaKoboFor(minor, rate.rate),
    abroad: true,
    ...(year ? { term: "year" as const } : {}),
  };
}

export async function proPriceFor(userId: string, log?: FastifyBaseLogger, term: ProTerm = "month"): Promise<ProPrice> {
  const { rows } = await db().query<{ wa_phone: string }>(`SELECT wa_phone FROM users WHERE id = $1`, [userId]);
  return proPriceForPhone(rows[0]?.wa_phone, log, currentRate, term);
}

/** Said under a price abroad, so the naira on Paystack's page is no surprise. */
export const chargedAs = (p: ProPrice): string | null =>
  p.abroad
    ? `Charged as ${formatNaira(p.chargeKobo)} at today's rate. Your bank converts it, so your statement may differ slightly.`
    : null;
