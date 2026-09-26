/**
 * Where "Pay Now" goes.
 *
 * The button on the Pro offer points here rather than at a payment page made
 * in advance, because a WhatsApp message lasts for ever and a payment does
 * not. Somebody scrolling back to an offer from last week taps a live link,
 * and the payment is set up at that moment.
 *
 * Pro is paid by bank transfer through Paystack, since 26 September 2026.
 * This opens an account for the one payment and shows it; nothing here marks
 * anything paid. The Paystack webhook does that, under the `sub_` reference
 * chosen here, and `confirmSubscription` turns it into a month of Pro, a
 * WhatsApp message and an emailed receipt.
 *
 * Nothing is trusted from the query string beyond the signature on the token.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../../db/pool.ts";
import { env } from "../../config.ts";
import { userForProToken } from "../../billing/pro-link.ts";
import { openSubscription, attachPaymentReference } from "../../billing/subscription.ts";
import { chargeByTransfer } from "../../payments/paystack.ts";
import { renderNotFound, renderProTransfer } from "../../documents/page.ts";

const HTML = "text/html; charset=utf-8";

/** How long an account stays open. Long enough to find a bank app and log in. */
const ACCOUNT_MINUTES = 60;

const site = (): string => env.SITE_URL.replace(/\/$/, "");
const api = (): string => env.PUBLIC_BASE_URL.replace(/\/$/, "");

export async function proRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string } }>("/pro/start", async (req, reply) => {
    const token = req.query.t ?? "";
    const userId = token ? userForProToken(token) : null;
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    const { rows } = await db().query<{
      email: string | null;
      business_name: string | null;
      plan: "free" | "pro";
    }>(`SELECT email, business_name, plan FROM users WHERE id = $1 AND status = 'active'`, [userId]);

    const user = rows[0];
    if (!user) return reply.status(404).type(HTML).send(renderNotFound());

    // Already paid. Showing an account would take the money twice.
    if (user.plan === "pro") return reply.redirect(`${site()}/pro/success`, 303);

    const opened = await openSubscription(userId, "link", req.log);
    const page = (a: {
      bankName: string;
      accountNumber: string;
      accountName: string;
      expiresAt: Date;
    }) =>
      reply.type(HTML).header("cache-control", "no-store").send(
        renderProTransfer({
          ...a,
          amountKobo: opened.priceKobo,
          statusUrl: `${api()}/pro/status?t=${encodeURIComponent(token)}`,
          doneUrl: `${site()}/pro/success`,
        }),
      );

    /*
     * The account already open for this subscription, if it has not expired.
     *
     * A minute's margin, so nobody is shown an account that closes while
     * they are typing the number in.
     */
    const { rows: held } = await db().query<{
      transfer_bank_name: string | null;
      transfer_account_number: string | null;
      transfer_account_name: string | null;
      transfer_expires_at: Date | null;
    }>(
      `SELECT transfer_bank_name, transfer_account_number, transfer_account_name, transfer_expires_at
         FROM subscriptions
        WHERE id = $1 AND transfer_expires_at > now() + interval '1 minute'`,
      [opened.id],
    );
    const h = held[0];
    if (h?.transfer_account_number && h.transfer_expires_at) {
      return page({
        bankName: h.transfer_bank_name ?? "Paystack",
        accountNumber: h.transfer_account_number,
        accountName: h.transfer_account_name ?? "Balans",
        expiresAt: h.transfer_expires_at,
      });
    }

    const reference = `sub_${opened.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;
    const charged = await chargeByTransfer({
      email: user.email ?? `${userId}@users.balans.ng`,
      amountKobo: opened.priceKobo,
      reference,
      expiresAt: new Date(Date.now() + ACCOUNT_MINUTES * 60_000),
      metadata: { purpose: "balans_pro", user_id: userId, business: user.business_name ?? "" },
    });

    if (!charged.ok) {
      req.log.error({ userId, message: charged.message }, "could not open a Pro transfer account");
      return reply.status(502).type(HTML).send(renderNotFound());
    }

    const a = charged.account;
    // Without the reference the webhook has nothing to match the payment to,
    // and a paid subscription stays pending for ever.
    await attachPaymentReference(opened.id, a.reference);
    await db().query(
      `UPDATE subscriptions
          SET status = 'pending',
              transfer_bank_name = $2, transfer_account_number = $3,
              transfer_account_name = $4, transfer_expires_at = $5
        WHERE id = $1`,
      [opened.id, a.bankName, a.accountNumber, a.accountName, a.expiresAt],
    );

    req.log.info({ userId, reference: a.reference }, "Pro transfer account opened");
    return page(a);
  });

  /*
   * Whether it has worked yet, for the page to ask while it waits.
   *
   * Says only yes or no about a plan, to somebody holding a signed token for
   * that user. Nothing else about the account leaves here.
   */
  app.get<{ Querystring: { t?: string } }>("/pro/status", async (req, reply) => {
    const userId = req.query.t ? userForProToken(req.query.t) : null;
    if (!userId) return reply.status(404).send({ active: false });
    const { rows } = await db().query<{ plan: string }>(`SELECT plan FROM users WHERE id = $1`, [userId]);
    return reply.header("cache-control", "no-store").send({ active: rows[0]?.plan === "pro" });
  });
}
