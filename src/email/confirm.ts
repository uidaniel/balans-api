/**
 * The email, asked for after setup and confirmed by a link (31 October 2026).
 *
 * Setup used to ask for an email and a 6-digit code from the inbox before the
 * bank, and more than half of everybody who signed up stopped there. Now
 * setup is the business name, the bank and the terms, and the email comes
 * after the first invoice: they send it in the chat, and a tap on the link in
 * the email confirms it. Nothing to copy back.
 *
 * Only somebody with no confirmed email can set one this way. A confirmed
 * email is the second factor on a bank change (F17), so changing it is a job
 * for a person, not a message.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { checkLink, issueLink } from "../lib/codes.ts";
import { markEmailVerified, recordOutbound, setEmail } from "../conversation/store.ts";
import { renderEmailConfirm } from "../documents/page.ts";
import { sendText } from "../whatsapp/client.ts";
import { b, para } from "../whatsapp/format.ts";
import { displayNumber } from "../whatsapp/number.ts";
import { confirmEmailLink, sendEmail, welcomeEmail } from "./send.ts";

const HTML = "text/html; charset=utf-8";

export type LinkSent =
  | { ok: true; email: string }
  | { ok: false; why: "already_confirmed"; current: string }
  | { ok: false; why: "rate_limited" | "not_sent" };

/** Sends the link, after setting the address as theirs but unconfirmed. */
export async function sendEmailLink(userId: string, email: string, log: FastifyBaseLogger): Promise<LinkSent> {
  const { rows } = await db().query<{ email: string | null; verified: boolean; business_name: string | null }>(
    `SELECT email, email_verified_at IS NOT NULL AS verified, business_name FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (user?.verified && user.email && user.email !== email.toLowerCase()) {
    return { ok: false, why: "already_confirmed", current: user.email };
  }

  const issued = await issueLink(userId, email);
  if (!issued.ok) return { ok: false, why: "rate_limited" };
  if (!user?.verified) await setEmail(userId, email);

  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/email/confirm?u=${userId}&t=${issued.token}`;
  const sent = await sendEmail({ to: email, ...confirmEmailLink({ url, businessName: user?.business_name }) }, log);
  if (!sent.ok) {
    log.warn({ userId, reason: sent.reason }, "email confirmation link not sent");
    return { ok: false, why: "not_sent" };
  }
  log.info({ userId }, "email confirmation link sent");
  return { ok: true, email: email.toLowerCase() };
}

/** What the chat says after an address is sent. */
export function linkSentWords(r: LinkSent): string {
  if (r.ok) {
    return para(
      `📧 ${b(`Check ${r.email}.`)}`,
      "Tap the link in the email to confirm it. It works for a day.",
    );
  }
  if (r.why === "already_confirmed") {
    return para(
      `📧 Your email is ${b(r.current)}, and it is already confirmed.`,
      `To change it, email ${b(env.SUPPORT_EMAIL)} from that address and a person will do it.`,
    );
  }
  if (r.why === "rate_limited") return "📧 That is a few links in a short time. Wait a few minutes, then send your email again.";
  return "📧 I could not send the email just now. Send your address again in a minute.";
}

/** The page the link opens, and the press that confirms it. */
export async function emailConfirmRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { u?: string; t?: string } }>("/email/confirm", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const email = await linkFor(req.query.u, req.query.t, false);
    return reply.type(HTML).send(renderEmailConfirm(email ? "ask" : "gone", email));
  });

  app.post<{ Querystring: { u?: string; t?: string } }>("/email/confirm", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const userId = req.query.u ?? "";
    const email = await linkFor(userId, req.query.t, true);
    if (!email) return reply.type(HTML).send(renderEmailConfirm("gone", null));

    const { rows } = await db().query<{ was: boolean; set_up: boolean; wa_phone: string; business_name: string | null }>(
      `SELECT email_verified_at IS NOT NULL AS was, activated_setup_at IS NOT NULL AS set_up, wa_phone, business_name
         FROM users WHERE id = $1`,
      [userId],
    );
    await markEmailVerified(userId, email);
    const u = rows[0];

    // The welcome email waited for an address it may send to, which setup no
    // longer collects. The first confirmation is when it can go.
    if (u && !u.was && u.set_up) {
      void sendEmail(
        { to: email, ...welcomeEmail({ businessName: u.business_name, email, waNumber: await displayNumber() }) },
        req.log,
      ).catch(() => undefined);
    }
    if (u?.wa_phone) {
      const res = await sendText(
        u.wa_phone,
        para(`✅ ${b("Email confirmed.")}`, `Copies of your invoices and receipts now go to ${b(email)}.`),
      ).catch(() => null);
      if (res?.ok) await recordOutbound(userId, res.waMessageId, "sent").catch(() => undefined);
    }
    req.log.info({ userId }, "email confirmed by link");
    return reply.type(HTML).send(renderEmailConfirm("done", email));
  });
}

async function linkFor(userId: string | undefined, token: string | undefined, consume: boolean): Promise<string | null> {
  if (!userId || !/^[0-9a-f-]{36}$/.test(userId) || !token) return null;
  return checkLink(userId, token, consume).catch(() => null);
}
