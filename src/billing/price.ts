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

export type ProPrice = {
  /** What the person reads: "₦3,000", "£4", "KSh 400". */
  label: string;
  /** What the Paystack checkout charges, in kobo. */
  chargeKobo: number;
  /** Priced in another currency and charged in naira. */
  abroad: boolean;
};

/** The naira price, for Nigeria and for anywhere a rate cannot be had. */
export const NAIRA_PRICE: ProPrice = {
  label: formatNaira(defaults.plans.pro.priceKobo),
  chargeKobo: defaults.plans.pro.priceKobo,
  abroad: false,
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
): Promise<ProPrice> {
  const local = proPriceAbroad(phone);
  if (!local || local.currency === "NGN") return NAIRA_PRICE;
  const rate = await rateOf(local.currency, log ? { log } : {}).catch(() => null);
  if (!rate) {
    log?.warn({ currency: local.currency }, "no rate for a Pro price abroad; using the naira price");
    return NAIRA_PRICE;
  }
  return { label: label(local.minor, local.currency), chargeKobo: nairaKoboFor(local.minor, rate.rate), abroad: true };
}

export async function proPriceFor(userId: string, log?: FastifyBaseLogger): Promise<ProPrice> {
  const { rows } = await db().query<{ wa_phone: string }>(`SELECT wa_phone FROM users WHERE id = $1`, [userId]);
  return proPriceForPhone(rows[0]?.wa_phone, log);
}

/** Said under a price abroad, so the naira on Paystack's page is no surprise. */
export const chargedAs = (p: ProPrice): string | null =>
  p.abroad
    ? `Charged as ${formatNaira(p.chargeKobo)} at today's rate. Your bank converts it, so your statement may differ slightly.`
    : null;
