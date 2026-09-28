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
import { GRACE_DAYS, type SubscriptionState } from "./subscription.ts";

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
      `✅ Invoices sent straight to your client's WhatsApp`,
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
 * The button under the offer, which opens Paystack's checkout.
 *
 * Since 26 September 2026 it opens the checkout in WhatsApp's own browser
 * rather than sending an account number to copy: one tap, and card, bank
 * transfer, USSD and the rest are all on the page. At most 20 characters,
 * which Meta enforces by refusing the whole message.
 */
export const proPayLabel = (): string => `Pay ${formatNaira(pro.priceKobo)}`;

/** Under the button, at most 60 characters. */
export const PRO_PAY_FOOTER = "Card, bank transfer or USSD, through Paystack";

/** For "pay now" typed or tapped: the same button, with less to read above it. */
export function proPayPrompt(): string {
  return para(
    `⭐ ${b(`Pro is ${formatNaira(pro.priceKobo)} a month.`)}`,
    "Tap below to pay by card, bank transfer or USSD.",
    i("Pro starts the moment it goes through, and your receipt comes here and to your email."),
  );
}

/** When the button cannot be sent: the same thing, as a link in words. */
export function proPayLink(words: string, url: string): string {
  return para(words, `Pay here: ${url}`);
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

/* -------------------------------------------------------------------------- */
/* Around the end of a Pro month                                              */
/* -------------------------------------------------------------------------- */

const day = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: defaults.behaviour.timezone, day: "numeric", month: "long" }).format(d);

const graceEnd = (end: Date) => new Date(end.getTime() + GRACE_DAYS * 86_400_000);

/** Three days before. It does not renew by itself, so this says how to. */
export function proEndingSoon(end: Date): string {
  return para(
    `⭐ ${b(`Your Balans Pro ends on ${day(end)}.`)}`,
    lines(
      `Reply ${b("upgrade")} to renew: ${formatNaira(pro.priceKobo)} for another month.`,
      "The new month starts when this one ends, so renewing early costs you nothing.",
    ),
  );
}

/** The day it ends. The grace week has started. */
export function proEnded(end: Date): string {
  return para(
    `⏳ ${b("Your Balans Pro ended today.")}`,
    lines(
      `You keep every Pro feature until ${day(graceEnd(end))}.`,
      `Reply ${b("upgrade")} to renew for ${formatNaira(pro.priceKobo)} a month.`,
    ),
  );
}

/** The last day of the grace week. */
export function proGraceEnding(end: Date): string {
  return para(
    `⏳ ${b("Last day of Pro.")}`,
    lines(
      `Tomorrow your account moves to Free: ${free.documentsPerMonth} invoices a month, and no logo on them.`,
      `Reply ${b("upgrade")} to keep Pro for ${formatNaira(pro.priceKobo)}.`,
    ),
  );
}

/** The day they move to Free. */
export function proLapsed(): string {
  return para(
    `📋 ${b("You are on Free now.")}`,
    lines(
      `${free.documentsPerMonth} invoices a month. Your logo and settings are saved for when you come back.`,
      `Reply ${b("upgrade")} to get Pro back for ${formatNaira(pro.priceKobo)} a month.`,
    ),
  );
}

/** A week later, once, and then nothing more. */
export function proWinBack(): string {
  return para(
    `⭐ ${b("Still want Pro?")}`,
    lines(
      "Unlimited invoices, your logo on them, and reminders sent to your clients for you.",
      `Reply ${b("upgrade")}: ${formatNaira(pro.priceKobo)} a month.`,
    ),
  );
}

/**
 * What "upgrade" says to somebody still on Pro whose month is nearly up or
 * already in its grace week: the renewal, with the button under it. Anybody
 * else on Pro is told they are on Pro, as before.
 */
export function proRenewOffer(state: SubscriptionState): string {
  const end = state.periodEnd;
  return para(
    `⭐ ${b("Renew Balans Pro")} — ${b(formatNaira(pro.priceKobo))} for another month.`,
    end
      ? state.inGrace
        ? lines(`Your month ended on ${day(end)}. You keep Pro until ${day(graceEnd(end))}.`)
        : lines(`Your month ends on ${day(end)}. The new one starts then, so nothing is lost.`)
      : "",
  );
}
