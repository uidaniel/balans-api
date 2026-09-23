/**
 * Security alerts (PRD F17 step 3, F16's `security_alert` template).
 *
 * Sent to WhatsApp *and* email, deliberately. The whole point of an alert
 * about a bank change is that the person reading it might not be the person
 * who made it — and if a WhatsApp account has been taken over, a WhatsApp
 * message is being read by the wrong person. The email is the one that
 * reaches the owner.
 *
 * Neither channel is allowed to fail the operation. The change is already
 * scheduled by the time these go out; an alert that could not be delivered is
 * a reason to shout in the logs, not to leave the account half-changed.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { b, lines, para } from "../whatsapp/format.ts";
import { send } from "../whatsapp/outbound.ts";
import { sendEmail } from "../email/send.ts";
import { layout, noteBlock, paragraph } from "../email/layout.ts";

export type SecurityEvent = {
  userId: string;
  /** Plain words, as they will appear mid-sentence: "your payout bank was changed". */
  what: string;
  /** The detail a person needs to judge whether it was them. */
  detail: string[];
  /** What to do if it was not them. */
  undoHint: string;
};

/** "14:20 today", in Lagos, because that is where the person is. */
function whenWords(now = new Date()): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.NODE_ENV === "test" ? "UTC" : "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${time} today`;
}

export function alertMessage(e: SecurityEvent, when = whenWords()): string {
  return para(
    `🔐 ${b("Security notice")} — ${e.what} at ${when}.`,
    lines(...e.detail),
    lines(
      "If that was you, there is nothing to do.",
      `${b("If it was not you")}, ${e.undoHint}`,
    ),
  );
}

export function alertEmail(
  e: SecurityEvent,
  businessName: string | null,
  when = whenWords(),
): { subject: string; html: string; text: string } {
  const what = e.what.charAt(0).toUpperCase() + e.what.slice(1);

  // The heading already says what happened, so the block says when, and what
  // the change actually was.
  const body = [
    paragraph(escapeHtml(businessName ? `Hello ${businessName},` : "Hello,")),
    noteBlock([`${what} at ${when}.`, ...e.detail]),
    paragraph("If that was you, there is nothing to do."),
    paragraph(`<strong>If it was not you</strong>, ${escapeHtml(e.undoHint)}`),
  ].join("\n");

  return {
    subject: `Security notice: ${e.what}`,
    html: layout({
      // The inbox preview is where this is first read, and often the only
      // place: it has to say what happened without being opened.
      preheader: `${what} at ${when}.`,
      eyebrow: "Security",
      heading: `${what}`,
      body,
    }),
    text: [
      `${what} at ${when}.`,
      "",
      ...e.detail,
      "",
      "If that was you, there is nothing to do.",
      `If it was not you, ${e.undoHint}`,
    ].join("\n"),
  };
}

/**
 * Sends to both channels, and never throws.
 *
 * WhatsApp goes through the window path with the `security_alert` template as
 * its fallback, because this is precisely the message that must arrive when
 * the user is not in a conversation.
 */
export async function raiseSecurityAlert(e: SecurityEvent, log: FastifyBaseLogger): Promise<void> {
  const { rows } = await db()
    .query<{ wa_phone: string; email: string | null; business_name: string | null }>(
      `SELECT wa_phone, email, business_name FROM users WHERE id = $1`,
      [e.userId],
    )
    .catch(() => ({ rows: [] as never[] }));

  const user = rows[0];
  if (!user) {
    log.error({ userId: e.userId }, "security alert for a user who is not there");
    return;
  }

  const when = whenWords();

  await send(
    {
      userId: e.userId,
      phone: user.wa_phone,
      text: alertMessage(e, when),
      fallback: { template: "security_alert", params: [e.what, when] },
    },
    log,
  ).catch((err: unknown) => log.error({ err, userId: e.userId }, "security alert: whatsapp failed"));

  if (user.email) {
    const mail = alertEmail(e, user.business_name, when);
    await sendEmail({ to: user.email, ...mail }, log).catch((err: unknown) =>
      log.error({ err, userId: e.userId }, "security alert: email failed"),
    );
  } else {
    log.error({ userId: e.userId }, "security alert with no email on file");
  }

  log.warn({ userId: e.userId, what: e.what }, "security alert raised");
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
