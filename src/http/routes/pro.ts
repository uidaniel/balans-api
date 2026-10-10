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
import { chargedAs, proPriceFor } from "../../billing/price.ts";
import { renewalOpen, stateOf } from "../../billing/subscription.ts";
import { formatNaira } from "../../../core/totals.ts";
import { defaults } from "../../config.ts";
import { renderNotFound, renderProPlans, renderProUnavailable } from "../../documents/page.ts";

const HTML = "text/html; charset=utf-8";

const site = (): string => env.SITE_URL.replace(/\/$/, "");

export async function proRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string; term?: string } }>("/pro/start", async (req, reply) => {
    const token = req.query.t ?? "";
    const userId = token ? userForProToken(token) : null;
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    /*
     * No plan named: the choice first (10 October 2026). Monthly or yearly,
     * each with its price and the day Pro would run until; each links back
     * here with its term, which goes on to Paystack.
     */
    const term = req.query.term === "year" ? "year" : req.query.term === "month" ? "month" : null;
    if (!term) {
      const state = await stateOf(userId);
      reply.header("cache-control", "no-store");
      if (state.plan === "pro" && !renewalOpen(state)) return reply.redirect(`${site()}/pro/success`, 303);
      const [month, year] = await Promise.all([proPriceFor(userId, req.log), proPriceFor(userId, req.log, "year")]);
      // From the end of what is paid, as the subscription itself counts it.
      const now = new Date();
      const from = state.periodEnd && state.periodEnd > now ? state.periodEnd : now;
      const until = (months: number) => {
        const d = new Date(from.getTime());
        d.setMonth(d.getMonth() + months);
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: defaults.behaviour.timezone,
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(d);
      };
      const base = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pro/start?t=${encodeURIComponent(token)}`;
      return reply.type(HTML).send(
        renderProPlans({
          monthLabel: month.label,
          yearLabel: year.label,
          yearPerMonth: year.abroad ? null : formatNaira(Math.round(year.chargeKobo / 12)),
          monthUntil: until(1),
          yearUntil: until(12),
          monthUrl: `${base}&term=month`,
          yearUrl: `${base}&term=year`,
          renewing: state.plan === "pro",
          note: chargedAs(month) ? "Charged in naira at today's rate. Your bank converts it, so your statement may differ slightly." : null,
        }),
      );
    }

    const opened = await openProCheckout(userId, req.log, term);
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
