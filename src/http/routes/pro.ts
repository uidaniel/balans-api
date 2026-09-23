/**
 * Where "Pay Now" goes.
 *
 * The button on the Pro offer points here rather than straight at a Monnify
 * checkout, because a WhatsApp message lasts for ever and a checkout URL does
 * not. Somebody scrolling back to an offer from last week taps a live link,
 * and the transaction is created at that moment — so nobody who only read the
 * offer has one sitting at Monnify unpaid.
 *
 * Nothing here is trusted from the query string beyond the signature on the
 * token, and nothing here marks anything paid. It opens a checkout and sends
 * the browser to it; the webhook is what decides whether money arrived.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../../db/pool.ts";
import { env } from "../../config.ts";
import { userForProToken } from "../../billing/pro-link.ts";
import { openSubscription, attachPaymentReference } from "../../billing/subscription.ts";
import { initTransaction } from "../../payments/monnify.ts";
import { renderNotFound } from "../../documents/page.ts";

const HTML = "text/html; charset=utf-8";

export async function proRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string } }>("/pro/start", async (req, reply) => {
    const userId = req.query.t ? userForProToken(req.query.t) : null;
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    const { rows } = await db().query<{
      email: string | null;
      business_name: string | null;
      plan: "free" | "pro";
    }>(`SELECT email, business_name, plan FROM users WHERE id = $1 AND status = 'active'`, [userId]);

    const user = rows[0];
    if (!user) return reply.status(404).type(HTML).send(renderNotFound());

    // Already paid. Sending them to a checkout would take the money twice.
    if (user.plan === "pro") {
      return reply.redirect(`${env.SITE_URL.replace(/\/$/, "")}/pro/success`, 303);
    }

    const opened = await openSubscription(userId, "link", req.log);
    const reference = `sub_${opened.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;

    const init = await initTransaction({
      amountKobo: opened.priceKobo,
      customerName: user.business_name ?? "Balans user",
      customerEmail: user.email ?? `${userId}@users.balans.ng`,
      paymentReference: reference,
      description: "Balans Pro, one month",
      redirectUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/callback?ref=${reference}`,
      // No split: this payment is ours, not the user's.
    });

    if (!init.ok) {
      req.log.error({ userId, message: init.message }, "could not open a Pro checkout");
      return reply.status(502).type(HTML).send(renderNotFound());
    }

    // Without this the webhook has nothing to match the payment to, and a
    // paid subscription stays pending for ever.
    await attachPaymentReference(opened.id, reference);
    await db().query(`UPDATE subscriptions SET status = 'pending' WHERE id = $1`, [opened.id]);

    req.log.info({ userId, reference }, "Pro checkout opened from the button");
    return reply.redirect(init.checkoutUrl, 303);
  });
}
