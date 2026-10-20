/**
 * What Balans takes on a card payment from abroad (20 October 2026).
 *
 * A flat fee a payment and nothing else: no percentage, whatever the plan, so
 * the figure the freelancer is told on the draft is the figure Paystack
 * collects. `settle` is handed zero plan rates with this as its flat fee.
 */

import type { BalansRates } from "../../core/fees.ts";
import { todayIn, type Civil } from "../../core/dates.ts";
import { defaults } from "../config.ts";

export const NO_PERCENTAGE: BalansRates = { percentBps: 0, minKobo: 0, capKobo: 0 };

const from = (): Civil => {
  const [y, m, d] = defaults.international.balansFeeFrom.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};

/** ₦1,000 from the start date, nothing before it. */
export function cardFeeKobo(today: Civil = todayIn(defaults.behaviour.timezone)): number {
  const f = from();
  const on = today.y !== f.y ? today.y > f.y : today.m !== f.m ? today.m > f.m : today.d >= f.d;
  return on ? defaults.international.balansFeeKobo : 0;
}
