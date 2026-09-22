/**
 * What Pro says (PRD F18).
 *
 * "Go Pro explains the plan in one message and offers two ways to pay." One
 * message, because a pricing page split across three bubbles is a pricing page
 * nobody reads to the end.
 */

import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { availableTo } from "../pdf/templates.ts";
import { b, i, lines, para } from "../whatsapp/format.ts";
import type { SubscriptionState } from "./subscription.ts";

const free = defaults.plans.free;
const pro = defaults.plans.pro;

export function proOffer(used: number): string {
  /*
   * Ticks rather than bullets.
   *
   * This is the one message with a budget for more than a single emoji. Every
   * other message gets one opener and no more, because varied emoji stop
   * meaning anything; a repeated marker is different in kind — it is
   * structure, uniform down the list, and it reads as a tick rather than as
   * decoration. `voice.test.ts` allows exactly that and nothing looser.
   */
  return para(
    `⭐ ${b("Balans Pro")} — ${b(formatNaira(pro.priceKobo))} a month.`,
    lines(
      `✅ Unlimited invoices (Free stops at ${free.documentsPerMonth}; you have used ${used})`,
      // Stated as the absence of a thing, not as a smaller number. "0.5%
      // instead of 1%" is an argument somebody has to do arithmetic to
      // believe; "no fee" is a fact they can check on the next invoice.
      pro.feePercentBps === 0
        ? `✅ ${b("No transaction fee")} — Free pays ${free.feePercentBps / 100}%`
        : `✅ ${pro.feePercentBps / 100}% transaction fee instead of ${free.feePercentBps / 100}%`,
      `✅ Automatic reminders, so you stop chasing`,
      `✅ Your logo on every invoice`,
      // Counted from the registry, so the claim cannot outlive the designs.
      `✅ All ${availableTo("pro").length} invoice designs`,
    ),
    // One action, named plainly. The deduction is offered underneath rather
    // than beside it, so there is a thing to do and then an alternative —
    // not two options of equal weight to choose between.
    `Reply ${b("pay now")} for a payment link.`,
    lines(
      `Or reply ${b("from my invoices")} and we take it from your next paid invoice.`,
      i("That way costs you nothing until a client pays you."),
    ),
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
      pro.feePercentBps === 0
        ? "Unlimited invoices, no transaction fee, and reminders that go out on their own."
        : "Unlimited invoices, a lower fee, and reminders that go out on their own.",
      "Send me your logo as a picture and it goes on every invoice from the next one.",
      `Reply ${b("/design")} to pick how they look.`,
    ),
  );
}
