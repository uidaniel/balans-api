/**
 * What Pro says (PRD F18).
 *
 * "Go Pro explains the plan in one message and offers two ways to pay." One
 * message, because a pricing page split across three bubbles is a pricing page
 * nobody reads to the end.
 */

import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { b, i, lines, para } from "../whatsapp/format.ts";
import type { SubscriptionState } from "./subscription.ts";

const free = defaults.plans.free;
const pro = defaults.plans.pro;

export function proOffer(used: number): string {
  return para(
    `⭐ ${b("Balans Pro")} — ${b(formatNaira(pro.priceKobo))} a month.`,
    lines(
      `· Unlimited invoices (Free stops at ${free.documentsPerMonth}; you have used ${used})`,
      `· ${pro.feePercentBps / 100}% transaction fee instead of ${free.feePercentBps / 100}%`,
      `· Automatic reminders, so you stop chasing`,
      `· Your logo on every invoice`,
    ),
    lines(
      b("Two ways to pay:"),
      `Reply ${b("pay now")} for a payment link.`,
      `Reply ${b("from my invoices")} and we take it from your next paid invoice.`,
    ),
    i("The second one costs you nothing until a client pays you."),
  );
}

/** Deduct-from-invoice, confirmed. The cap is the reassurance, so it is said. */
export function deductChosen(): string {
  return para(
    `✅ ${b("Pro starts with your next paid invoice.")}`,
    lines(
      `We will take ${formatNaira(pro.priceKobo)} out of it, a bit at a time if it is small.`,
      "We never take more than a fifth of any single payment.",
    ),
    i("Nothing to pay today."),
  );
}

export function payLinkMessage(url: string): string {
  return para(
    `⭐ ${b(`Pro is ${formatNaira(pro.priceKobo)} for a month.`)}`,
    lines("Pay here and it starts straight away:", url),
    i("Card, transfer or USSD."),
  );
}

export function proActive(state: SubscriptionState): string {
  const until = state.periodEnd
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: defaults.behaviour.timezone,
        day: "numeric",
        month: "short",
      }).format(state.periodEnd)
    : "next month";

  return para(
    `⭐ ${b("You are on Pro.")}`,
    lines(
      `Renews ${until}.`,
      state.owedKobo > 0
        ? `${formatNaira(state.owedKobo)} still to collect from your next paid invoice.`
        : "Nothing outstanding.",
    ),
  );
}

/** F18: activated by the first money in, whether a deduction or the link. */
export function proStarted(): string {
  return para(
    `🎉 ${b("Pro is active.")}`,
    lines(
      "Unlimited invoices, a lower fee, and reminders that go out on their own.",
      `Reply ${b("settings")} to add your logo.`,
    ),
  );
}
