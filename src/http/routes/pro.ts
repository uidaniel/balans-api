/**
 * Where "Pay" in the chat goes: straight on to Paystack's checkout.
 *
 * Opened in WhatsApp's own browser from the button under the Pro offer. Each
 * visit opens a fresh checkout (billing/pro-checkout.ts), so the link in an
 * old offer still works, and so does one tapped twice. Links in offers sent
 * before 26 September 2026 point here too, and now land on the same checkout.
 *
 * Nothing is trusted from the query string beyond the signature on the token.
 */

import type { FastifyInstance } from "fastify";
import { db } from "../../db/pool.ts";
import { env } from "../../config.ts";
import { userForProToken } from "../../billing/pro-link.ts";
import { openProCheckout } from "../../billing/pro-checkout.ts";
import { renderNotFound, renderProUnavailable } from "../../documents/page.ts";

const HTML = "text/html; charset=utf-8";

const site = (): string => env.SITE_URL.replace(/\/$/, "");

export async function proRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string; term?: string } }>("/pro/start", async (req, reply) => {
    const token = req.query.t ?? "";
    const userId = token ? userForProToken(token) : null;
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    // "&term=year" from the yearly button; anything else is a month.
    const opened = await openProCheckout(userId, req.log, req.query.term === "year" ? "year" : "month");
    reply.header("cache-control", "no-store");
    if (opened.kind === "already_pro") return reply.redirect(`${site()}/pro/success`, 303);
    if (opened.kind === "failed") return reply.status(502).type(HTML).send(renderProUnavailable());
    return reply.redirect(opened.url, 303);
  });

  /*
   * Whether it has worked yet.
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
