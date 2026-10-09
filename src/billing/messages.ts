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
import { chargedAs, NAIRA_PRICE, type ProPrice } from "./price.ts";

const free = defaults.plans.free;
const pro = defaults.plans.pro;

export function proOffer(used: number, price: ProPrice = NAIRA_PRICE, year?: ProPrice): string {
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
    `⭐ ${b("Balans Pro")} — ${b(price.label)} a month.`,
    chargedAs(price) ?? "",
    lines(
      `✅ Unlimited invoices (Free stops at ${free.documentsPerMonth}; you have used ${used})`,
      // No fee line any more. Naira invoices are paid straight into the
      // user's own account on every plan, so there is no fee for Pro to
      // remove, and saying "no transaction fee" would sell the absence of
      // something Free does not charge either.
      `✅ Invoices sent straight to your client's WhatsApp`,
      `✅ Reminders to your clients by email, so you stop chasing`,
      // Only while it is switched on: an offer is a promise.
      ...(env.INTL_ENABLED ? [`✅ Invoices in dollars, pounds, euros and 6 more currencies`] : []),
      `✅ Your logo on every invoice`,
      // Counted from the registry, so the claim cannot outlive the designs.
      `✅ All ${availableTo("pro").length} invoice designs`,
    ),
    year ? yearLine(year) : "",
  );
}

/**
 * The year, offered under the month (9 October 2026): twelve months for the
 * price of ten, said as what it saves.
 */
export function yearLine(year: ProPrice): string {
  return `💡 Or ${b(year.label)} for a whole year — two months free. Reply ${b("yearly")}.`;
}

/**
 * The button under the offer, which opens Paystack's checkout.
 *
 * Since 26 September 2026 it opens the checkout in WhatsApp's own browser
 * rather than sending an account number to copy: one tap, and card, bank
 * transfer, USSD and the rest are all on the page. At most 20 characters,
 * which Meta enforces by refusing the whole message.
 */
export const proPayLabel = (price: ProPrice = NAIRA_PRICE): string => `Pay ${price.label}`;

/** Under the button, at most 60 characters. */
export const PRO_PAY_FOOTER = "Card, bank transfer or USSD, through Paystack";

/** For "pay now" typed or tapped: the same button, with less to read above it. */
export function proPayPrompt(price: ProPrice = NAIRA_PRICE): string {
  return para(
    price.term === "year"
      ? `⭐ ${b(`A year of Pro is ${price.label}.`)} Twelve months for the price of ten.`
      : `⭐ ${b(`Pro is ${price.label} a month.`)}`,
    chargedAs(price) ?? "Tap below to pay by card, bank transfer or USSD.",
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
export function proStarted(
  receipt?: { paidKobo: number; until: Date },
  /** Given by Balans rather than paid for: until when, or null for no end. */
  granted?: { until: Date | null },
): string {
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
      : granted
        ? [
            granted.until
              ? `Balans has put you on Pro until ${b(day(granted.until))}. Nothing to pay.`
              : `Balans has put you on Pro, with no end date. Nothing to pay.`,
          ]
        : []),
    lines(
      env.INTL_ENABLED
        ? "Unlimited invoices, reminders that go out on their own, and invoices in dollars, pounds, euros and more."
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
export function proEndingSoon(end: Date, price: ProPrice = NAIRA_PRICE): string {
  return para(
    `⭐ ${b(`Your Balans Pro ends on ${day(end)}.`)}`,
    lines(
      "It does not renew by itself.",
      `Tap below to pay ${price.label} for another month. It starts when this one ends, so renewing early costs you nothing.`,
    ),
  );
}

/** The day it ends. The grace week has started. */
export function proEnded(end: Date, price: ProPrice = NAIRA_PRICE): string {
  return para(
    `⏳ ${b("Your Balans Pro ended today.")}`,
    lines(
      `You keep every Pro feature until ${day(graceEnd(end))}.`,
      `Tap below to renew for ${price.label} a month.`,
    ),
  );
}

/** The last day of the grace week. */
export function proGraceEnding(end: Date, price: ProPrice = NAIRA_PRICE): string {
  return para(
    `⏳ ${b("Last day of Pro.")}`,
    lines(
      `Tomorrow your account moves to Free: ${free.documentsPerMonth} invoices a month, and no logo on them.`,
      `Tap below to keep Pro for ${price.label}.`,
    ),
  );
}

/** The day they move to Free. */
export function proLapsed(price: ProPrice = NAIRA_PRICE): string {
  return para(
    `📋 ${b("You are on Free now.")}`,
    lines(
      `${free.documentsPerMonth} invoices a month. Your logo and settings are saved for when you come back.`,
      `Tap below to get Pro back for ${price.label} a month.`,
    ),
  );
}

/** A week later, once, and then nothing more. */
export function proWinBack(price: ProPrice = NAIRA_PRICE): string {
  return para(
    `⭐ ${b("Still want Pro?")}`,
    lines(
      "Unlimited invoices, your logo on them, and reminders sent to your clients for you.",
      `Tap below: ${price.label} a month.`,
    ),
  );
}

/**
 * What "upgrade" says to somebody still on Pro whose month is nearly up or
 * already in its grace week: the renewal, with the button under it. Anybody
 * else on Pro is told they are on Pro, as before.
 */
export function proRenewOffer(state: SubscriptionState, price: ProPrice = NAIRA_PRICE, year?: ProPrice): string {
  const end = state.periodEnd;
  return para(
    `⭐ ${b("Renew Balans Pro")} — ${b(price.label)} for another month.`,
    end
      ? state.inGrace
        ? lines(`Your Pro ended on ${day(end)}. You keep it until ${day(graceEnd(end))}.`)
        : lines(`Your Pro ends on ${day(end)}. The new period starts then, so nothing is lost.`)
      : "",
    year ? yearLine(year) : "",
  );
}
