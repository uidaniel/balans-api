/**
 * The notice of terms and privacy 6.0 (published 4 November 2026, in force
 * 4 December 2026).
 *
 * The terms promise 30 days' notice of a material change, in the chat and by
 * email, and ask each person to accept the new version. This sends that
 * notice once to everybody who has finished setup and not accepted: a
 * message with an "I accept" button while they are inside WhatsApp's 24-hour
 * window, which is free, and an email to a confirmed address. No template:
 * a paid message to every user was not worth it (4 November 2026), so
 * somebody who does not write to Balans before then has the email and the
 * notice on the website. It is a service message, so it goes whether or not
 * they said yes to updates. Accepting also records the yes to processing outside Nigeria
 * (legal/consent.ts).
 */

import type { FastifyBaseLogger } from "fastify";

import { NEXT_CONSENT, env } from "../config.ts";
import { db } from "../db/pool.ts";
import { recordOutbound } from "../conversation/store.ts";
import { sendButtons, type ReplyButton } from "../whatsapp/client.ts";
import { b, para } from "../whatsapp/format.ts";
import { windowFor } from "../whatsapp/window.ts";
import { sendEmail, type Email } from "../email/send.ts";
import { button, layout, paragraph } from "../email/layout.ts";

/** Not before the day it is published. */
const NOTICE_FROM = Date.parse("2026-11-04T00:00:00+01:00");
/** Per run, so a few hundred go over a few hours rather than at once. */
const BATCH = 100;

export const ACCEPT_BUTTON: ReplyButton = { id: "accept new terms", title: "I accept" };

const site = () => env.SITE_URL.replace(/\/$/, "");
export const termsLink = () => `${site()}/terms?v=${NEXT_CONSENT.version}`;
export const privacyLink = () => `${site()}/privacy?v=${NEXT_CONSENT.version}`;

/** The main points, in the chat and the email alike. */
export const NOTICE_POINTS = [
  "You can bill from outside Nigeria, and add your bank account during setup or later",
  "Invoices can carry payment details you write yourself, which Balans does not check",
  "We name every provider that holds your data, and the country it is in",
  "We ask your consent for your data to be processed outside Nigeria, in Ireland and the United States",
];

export function noticeText(): string {
  return para(
    `📄 ${b(`Balans terms and privacy notice, version ${NEXT_CONSENT.version}`)}`,
    `They change on ${NEXT_CONSENT.from}. The main points:\n${NOTICE_POINTS.map((p) => `• ${p}`).join("\n")}`,
    `Read them: ${termsLink()} and ${privacyLink()}`,
    `Tap ${b("I accept")} to agree, including your data being processed outside Nigeria. If you do not agree, you can close your account before ${NEXT_CONSENT.from}.`,
  );
}

export function noticeEmail(businessName: string | null): Omit<Email, "to"> {
  const hello = businessName ? `${businessName},` : "Hello,";
  return {
    sender: "support",
    subject: `Balans terms and privacy notice: version ${NEXT_CONSENT.version} from ${NEXT_CONSENT.from}`,
    replyTo: env.SUPPORT_EMAIL,
    text: [
      hello,
      "",
      `We are updating the Balans terms of use and privacy notice. Version ${NEXT_CONSENT.version} takes effect on ${NEXT_CONSENT.from}. The main points:`,
      ...NOTICE_POINTS.map((p) => `- ${p}`),
      "",
      `The terms: ${termsLink()}`,
      `The privacy notice: ${privacyLink()}`,
      "",
      `To accept, reply I ACCEPT to Balans on WhatsApp. That includes your data being processed outside Nigeria. If you do not agree, you can close your account before ${NEXT_CONSENT.from}.`,
    ].join("\n"),
    html: layout({
      preheader: `Version ${NEXT_CONSENT.version} takes effect on ${NEXT_CONSENT.from}.`,
      heading: `Our terms and privacy notice are changing on ${NEXT_CONSENT.from}`,
      body: [
        paragraph(hello),
        paragraph(`Version ${NEXT_CONSENT.version} of the Balans terms of use and privacy notice takes effect on ${NEXT_CONSENT.from}. The main points:`),
        paragraph(NOTICE_POINTS.map((p) => `• ${p}`).join("<br>")),
        button("Read the new terms", termsLink()),
        paragraph(`And the privacy notice: <a href="${privacyLink()}" style="color:inherit;">${privacyLink()}</a>`, true),
        paragraph(
          `To accept, reply <strong>I ACCEPT</strong> to Balans on WhatsApp. That includes your data being processed outside Nigeria. If you do not agree, you can close your account before ${NEXT_CONSENT.from}.`,
          true,
        ),
      ].join("\n"),
    }),
  };
}

/** Sends the notice to the next batch. Returns how many went, on either channel. */
export async function sendTermsNotices(log: FastifyBaseLogger, now: number = Date.now()): Promise<number> {
  if (now < NOTICE_FROM) return 0;
  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    business_name: string | null;
    email: string | null;
    wa_due: boolean;
    email_due: boolean;
  }>(
    `SELECT id, wa_phone, business_name,
            CASE WHEN email_verified_at IS NOT NULL THEN email END AS email,
            terms_notice_at IS NULL AS wa_due,
            terms_email_at IS NULL AND email_verified_at IS NOT NULL AS email_due
       FROM users
      WHERE status = 'active' AND deleted_at IS NULL AND consented_at IS NOT NULL
        AND consent_version IS DISTINCT FROM $1
        AND (terms_notice_at IS NULL OR (terms_email_at IS NULL AND email_verified_at IS NOT NULL))
      ORDER BY consented_at
      LIMIT 400`,
    [NEXT_CONSENT.version],
  );

  let sent = 0;
  let tried = 0;
  for (const r of rows) {
    if (tried >= BATCH) break;
    try {
      if (r.wa_due) {
        // Only inside the free window; outside it, the email and the website.
        const open = (await windowFor(r.id)).open;
        if (open) {
          const claim = await db().query(`UPDATE users SET terms_notice_at = now() WHERE id = $1 AND terms_notice_at IS NULL RETURNING id`, [r.id]);
          if (claim.rows.length) {
            tried += 1;
            const out = await sendButtons(r.wa_phone, { body: noticeText(), buttons: [ACCEPT_BUTTON] });
            if (out.ok) {
              sent += 1;
              await recordOutbound(r.id, out.waMessageId, "sent", { kind: "interactive" });
            } else {
              // Not delivered: let the next run try again.
              await db().query(`UPDATE users SET terms_notice_at = NULL WHERE id = $1`, [r.id]);
              log.warn({ userId: r.id, reason: out.reason }, "terms notice not sent");
            }
          }
        }
      }
      if (r.email_due && r.email) {
        const claim = await db().query(`UPDATE users SET terms_email_at = now() WHERE id = $1 AND terms_email_at IS NULL RETURNING id`, [r.id]);
        if (claim.rows.length) {
          tried += 1;
          const mail = await sendEmail({ to: r.email, ...noticeEmail(r.business_name) }, log);
          if (mail.ok) sent += 1;
          else await db().query(`UPDATE users SET terms_email_at = NULL WHERE id = $1`, [r.id]);
        }
      }
    } catch (e) {
      log.error({ userId: r.id, err: (e as Error).message }, "terms notice failed");
    }
  }
  if (tried) log.info({ tried, sent }, "terms notices");
  return sent;
}
