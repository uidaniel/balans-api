/**
 * Paystack's checkout for a month of Pro.
 *
 * Since 26 September 2026 "Pay" in the chat opens /pro/start in WhatsApp's
 * own browser, which lands here and is sent on to Paystack's checkout: card,
 * bank transfer, USSD and whatever else Paystack offers, on a page people
 * already know. It replaced an account number sent as a message, which only
 * worked for somebody paying by transfer and made them copy three things into
 * another app.
 *
 * Every visit opens a new checkout under a new reference, so a link tapped
 * again tomorrow still works. Each reference names its subscription (see
 * `proReference`), which is how a payment on any of them is found — not only
 * the latest one opened. The `charge.success` webhook does the rest: a month
 * of Pro and a receipt, in the chat and by email. Nothing here marks anything
 * paid.
 */

import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { initProCheckout } from "../payments/paystack.ts";
import { attachPaymentReference, openSubscription } from "./subscription.ts";

export type ProCheckout =
  | { kind: "checkout"; url: string }
  | { kind: "already_pro" }
  | { kind: "failed"; message: string };

/** "sub_" and the first 16 hex of the subscription id, then 8 of chance. */
export const proReference = (subscriptionId: string): string =>
  `sub_${subscriptionId.replace(/-/g, "").slice(0, 16)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** The subscription id prefix a reference names, or null for anything else. */
export function subscriptionPrefixOf(reference: string): string | null {
  return /^sub_([0-9a-f]{16})_[0-9a-f]{8}$/.exec(reference)?.[1] ?? null;
}

export async function openProCheckout(userId: string, log: FastifyBaseLogger): Promise<ProCheckout> {
  const { rows } = await db().query<{ email: string | null; business_name: string | null; plan: "free" | "pro" }>(
    `SELECT email, business_name, plan FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const user = rows[0];
  if (!user) return { kind: "failed", message: "no such user" };
  // Already paid. A checkout now would take the money twice.
  if (user.plan === "pro") return { kind: "already_pro" };

  const opened = await openSubscription(userId, "link", log);
  const reference = proReference(opened.id);

  const init = await initProCheckout({
    email: user.email ?? `${userId}@users.balans.ng`,
    amountKobo: opened.priceKobo,
    reference,
    // Back through the callback, which checks whether the webhook has
    // switched Pro on yet and lands on /pro/success saying which.
    callbackUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/callback`,
    metadata: { purpose: "balans_pro", user_id: userId, business: user.business_name ?? "" },
  });
  if (!init.ok) {
    log.error({ userId, message: init.message }, "could not open a Pro checkout");
    return { kind: "failed", message: init.message };
  }

  // The latest one, for the exact match. Earlier ones are still found by
  // their prefix; see confirmSubscription.
  await attachPaymentReference(opened.id, reference);
  log.info({ userId, reference }, "Pro checkout opened");
  return { kind: "checkout", url: init.authorizationUrl };
}
