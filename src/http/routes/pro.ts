/**
 * Where the old "Pay Now" link goes.
 *
 * Since 26 September 2026 "Pay Now" is a reply button and the account comes
 * back in the chat (see `start_pro` in handle.ts). Offers sent before that
 * carry a link here, and a WhatsApp message lasts for ever, so this still
 * works: it opens the same account the chat would and shows it on a page.
 *
 * Nothing is trusted from the query string beyond the signature on the token.
 */

import type { FastifyInstance } from "fastify";
import { db } from "../../db/pool.ts";
import { env } from "../../config.ts";
import { userForProToken } from "../../billing/pro-link.ts";
import { openProTransfer } from "../../billing/pro-transfer.ts";
import { renderNotFound, renderProTransfer } from "../../documents/page.ts";

const HTML = "text/html; charset=utf-8";

const site = (): string => env.SITE_URL.replace(/\/$/, "");
const api = (): string => env.PUBLIC_BASE_URL.replace(/\/$/, "");

export async function proRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string } }>("/pro/start", async (req, reply) => {
    const token = req.query.t ?? "";
    const userId = token ? userForProToken(token) : null;
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    const opened = await openProTransfer(userId, req.log);
    if (opened.kind === "already_pro") return reply.redirect(`${site()}/pro/success`, 303);
    if (opened.kind === "failed") return reply.status(502).type(HTML).send(renderNotFound());

    return reply.type(HTML).header("cache-control", "no-store").send(
      renderProTransfer({
        ...opened.account,
        amountKobo: opened.amountKobo,
        statusUrl: `${api()}/pro/status?t=${encodeURIComponent(token)}`,
        doneUrl: `${site()}/pro/success`,
      }),
    );
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
