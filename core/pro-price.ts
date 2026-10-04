/**
 * What Pro costs a month, by where the sender's WhatsApp number is.
 *
 * Agreed on 4 October 2026. Round local figures, fixed rather than converted,
 * so a price never moves with the exchange rate: about $5 in richer markets,
 * about $3 elsewhere in Africa (in line with Nigeria's ₦4,000), and $5 for
 * anywhere not named. Nigeria's price stays in config (defaults.plans.pro).
 *
 * Outside Nigeria Pro is to be charged through Dodo Payments, in the buyer's
 * own currency; until that is connected, nothing charges these.
 */

import type { Currency } from "./currency.ts";
import { homeCurrencyFor } from "./home-currency.ts";

export type ProPrice = { currency: Currency; minor: number };

const ABROAD: Partial<Record<Currency, number>> = {
  USD: 5_00,
  GBP: 4_00,
  EUR: 5_00,
  CAD: 7_00,
  AUD: 8_00,
  AED: 19_00,
  GHS: 35_00,
  KES: 400_00,
  ZAR: 59_00,
};

/**
 * Null for a Nigerian number: their price is the naira one in config. Any
 * other number gets its local price, or $5 where we have none.
 */
export function proPriceAbroad(phone: string | null | undefined): ProPrice | null {
  const digits = String(phone ?? "").replace(/\D/g, "").replace(/^00/, "");
  if (!digits || digits.startsWith("234")) return null;
  const home = homeCurrencyFor(digits);
  const minor = home === "NGN" ? undefined : ABROAD[home];
  return minor ? { currency: home, minor } : { currency: "USD", minor: ABROAD.USD! };
}
