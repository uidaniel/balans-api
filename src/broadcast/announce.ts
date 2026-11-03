/**
 * A message to every user, written in the admin (3 November 2026).
 *
 * WhatsApp: free-form to anybody who wrote to Balans in the last 24 hours,
 * and the `announcement` template (marketing, approved by Meta once) to
 * everybody else. Email: to a confirmed address, with a link to stop.
 * "STOP UPDATES" in the chat or that link turns announcements off for them;
 * invoices, receipts and reminders are the service and keep coming.
 */

import { createHmac } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { safeEqual } from "../lib/crypto.ts";
import { layout, paragraph } from "../email/layout.ts";
import { esc } from "../documents/page.ts";
import type { Email } from "../email/send.ts";

export const ANNOUNCEMENT = "announcement";

const base = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");

/** The opt-out line under every WhatsApp announcement. */
export const STOP_LINE = "Reply STOP UPDATES to stop these messages.";

/** A template's parameter cannot hold a line break: the paragraphs run on. */
export const oneParagraph = (message: string): string => message.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();

/** Free-form, inside the window: the message as written, and the way out. */
export const announcementText = (message: string): string => `${message.trim()}\n\n_${STOP_LINE}_`;

const sign = (userId: string): string =>
  createHmac("sha256", env.ENCRYPTION_KEY ?? "balans-updates").update(`updates-off:${userId}`).digest("hex").slice(0, 32);

export const stopUrl = (userId: string): string => `${base()}/updates/stop?u=${userId}&t=${sign(userId)}`;

export function announcementEmail(o: { subject: string; message: string; userId: string | null }): Omit<Email, "to"> {
  const paras = o.message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const stop = o.userId ? stopUrl(o.userId) : null;
  return {
    subject: o.subject,
    replyTo: env.SUPPORT_EMAIL,
    text: [...paras.flatMap((p) => [p, ""]), "—", stop ? `Stop Balans updates: ${stop}` : "", `Balans is a product of ${env.LEGAL_ENTITY_NAME}.`].join("\n"),
    html: layout({
      preheader: oneParagraph(o.message).slice(0, 110),
      heading: o.subject,
      body: [
        ...paras.map((p) => paragraph(esc(p).replace(/\n/g, "<br>"))),
        stop
          ? paragraph(`Don't want these? <a href="${esc(stop)}" style="color:inherit;">Stop Balans updates</a>. Your invoices and receipts are not affected.`, true)
          : "",
      ].join("\n"),
    }),
  };
}

/** Turns announcements off or on. Never throws. */
export async function setUpdates(userId: string, on: boolean): Promise<void> {
  await db()
    .query(`UPDATE users SET updates_off_at = ${on ? "NULL" : "COALESCE(updates_off_at, now())"} WHERE id = $1`, [userId])
    .catch(() => {});
}

/** The email's "Stop Balans updates" link. */
export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { u?: string; t?: string } }>("/updates/stop", async (req, reply) => {
    const u = String(req.query.u ?? "");
    const ok = /^[0-9a-f-]{36}$/i.test(u) && safeEqual(String(req.query.t ?? ""), sign(u));
    if (ok) await setUpdates(u, false);
    const words = ok
      ? ["You won't get Balans updates any more.", "Your invoices, receipts and reminders are not affected. To get updates again, send START UPDATES to Balans on WhatsApp."]
      : ["This link doesn't look right.", "Send STOP UPDATES to Balans on WhatsApp instead."];
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Balans updates</title>` +
          `<style>body{margin:0;background:#F6F1E7;color:#10231C;font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh}` +
          `main{max-width:420px;padding:32px 24px;text-align:center}h1{font-weight:500;font-size:22px;letter-spacing:-.02em}p{color:rgba(16,35,28,.65);line-height:1.5}</style></head>` +
          `<body><main><h1>${esc(words[0]!)}</h1><p>${esc(words[1]!)}</p></main></body></html>`,
      );
  });
}
