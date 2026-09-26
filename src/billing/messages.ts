/**
 * What Pro says (PRD F18).
 *
 * "Go Pro explains the plan in one message and offers two ways to pay." One
 * message, because a pricing page split across three bubbles is a pricing page
 * nobody reads to the end.
 */

import { formatNaira } from "../../core/totals.ts";
import { defaults, env } from "../config.ts";
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
      // No fee line any more. Naira invoices are paid straight into the
      // user's own account on every plan, so there is no fee for Pro to
      // remove, and saying "no transaction fee" would sell the absence of
      // something Free does not charge either.
      `✅ Reminders to your clients by email, so you stop chasing`,
      // Only while it is switched on: an offer is a promise.
      ...(env.INTL_ENABLED ? [`✅ Invoices in dollars and pounds, paid by card`] : []),
      `✅ Your logo on every invoice`,
      // Counted from the registry, so the claim cannot outlive the designs.
      `✅ All ${availableTo("pro").length} invoice designs`,
    ),
  );
}

/**
 * The two ways to start Pro.
 *
 * Ids are the phrases the parser already reads, so a tap and a typed reply
 * take the same path and neither needs a special case.
 */
export const proOfferButtons = (): { id: string; title: string }[] => [
  /*
   * One button, and no picture on it.
   *
   * Deduct-from-invoice is gone from the offer. Two ways to pay is a decision
   * to make before the one that matters — whether to upgrade at all — and the
   * second one needed a line of explanation above it to be understood, which
   * is a lot of message for an alternative most people were never going to
   * take.
   *
   * The id stays the phrase the parser reads, so a tap and a typed "pay now"
   * are the same message. `asProChoice` still understands "from my invoices"
   * for anybody who knows to ask, and the billing path behind it is untouched
   * — this removes the offer, not the feature.
   */
  { id: "pay now", title: "Pay Now" },
];

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

/**
 * The account to pay into, in the chat.
 *
 * Since 26 September 2026 "Pay Now" answers with this rather than a link out
 * of WhatsApp: the account is the thing they need, so it is the message. Each
 * detail on a line of its own, so a long-press on the number copies little
 * else, and the amount said as "exactly" because Paystack matches a transfer
 * to this account by its amount.
 */
export function proTransferMessage(
  account: { bankName: string; accountNumber: string; accountName: string; expiresAt: Date },
  amountKobo: number,
): string {
  const closes = new Intl.DateTimeFormat("en-GB", {
    timeZone: defaults.behaviour.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(account.expiresAt);
  return para(
    `⭐ ${b(`Transfer ${formatNaira(amountKobo)} to start Pro`)}`,
    lines(
      `Bank: ${b(account.bankName)}`,
      `Account number: ${b(account.accountNumber)}`,
      `Account name: ${b(account.accountName)}`,
      `Amount: ${b(formatNaira(amountKobo))}`,
    ),
    lines(
      `Send exactly ${formatNaira(amountKobo)} before ${closes}. This account is for this one payment.`,
      i("Pro starts the moment it lands, and your receipt comes here and to your email."),
    ),
  );
}

/** When no account could be opened. */
export const proTransferFailed = (): string =>
  "⏳ I could not open an account for the payment just now. Reply *pay* to try again in a minute.";

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

/**
 * F18: activated by the first money in, whether a deduction or the link.
 *
 * With what was paid, when it is known, as the receipt: the same facts the
 * email carries, for somebody who will never open the email.
 */
export function proStarted(receipt?: { paidKobo: number; until: Date }): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: defaults.behaviour.timezone,
      day: "numeric",
      month: "long",
    }).format(d);
  return para(
    `🎉 ${b("Pro is active.")}`,
    ...(receipt
      ? [
          lines(
            `🧾 ${b("Receipt")}`,
            `Paid: ${b(formatNaira(receipt.paidKobo))}, by bank transfer, ${day(new Date())}`,
            `Pro until: ${b(day(receipt.until))}`,
            "A copy is in your email.",
          ),
        ]
      : []),
    lines(
      env.INTL_ENABLED
        ? "Unlimited invoices, reminders that go out on their own, and invoices in dollars and pounds."
        : "Unlimited invoices, and reminders that go out on their own.",
      "Send me your logo as a picture and it goes on every invoice from the next one.",
      `Reply ${b("/design")} to pick how they look.`,
    ),
  );
}
