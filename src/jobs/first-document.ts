/**
 * The first-document nudge (5 November 2026).
 *
 * Of 102 people who finished setup, 51 never sent a document, and those who
 * do send start within minutes. So a few hours after setup, somebody who has
 * sent nothing gets one message: how to start, and the example. Once, and only
 * inside the WhatsApp window, where it is a reply rather than a template:
 * a nudge is not worth a paid message.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { recordOutbound } from "../conversation/store.ts";
import { sendButtons, type ReplyButton } from "../whatsapp/client.ts";
import { b, para } from "../whatsapp/format.ts";
import { windowFor } from "../whatsapp/window.ts";

/** Hours after setup before the nudge; the window closes at 24. */
export const NUDGE_AFTER_HOURS = 3;
const NUDGE_BEFORE_HOURS = 22;

export const NUDGE_BUTTONS: ReplyButton[] = [
  { id: "create invoice", title: "Create invoice" },
  { id: "try an example", title: "Try an example" },
];

export function nudgeText(name: string | null): string {
  return para(
    `🧾 ${b(name ? `${name}, your first invoice takes a minute.` : "Your first invoice takes a minute.")}`,
    `Tap ${b("Create invoice")}, or just type it: ${b("Invoice Tunde 150k for logo design, due Friday")}.`,
    `Not ready? ${b("Try an example")} shows you what your client gets.`,
  );
}

export async function sendFirstDocumentNudges(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; wa_phone: string; business_name: string | null }>(
    `SELECT u.id, u.wa_phone, u.business_name
       FROM users u
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND u.first_doc_nudge_at IS NULL
        AND u.consented_at < now() - make_interval(hours => $1::int)
        AND u.consented_at > now() - make_interval(hours => $2::int)
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.user_id = u.id AND d.status <> 'draft' AND d.type <> 'sample')
      LIMIT 100`,
    [NUDGE_AFTER_HOURS, NUDGE_BEFORE_HOURS],
  );
  let sent = 0;
  for (const r of rows) {
    try {
      if (!(await windowFor(r.id)).open) continue;
      const claim = await db().query(`UPDATE users SET first_doc_nudge_at = now() WHERE id = $1 AND first_doc_nudge_at IS NULL`, [r.id]);
      if (!claim.rowCount) continue;
      const out = await sendButtons(r.wa_phone, { body: nudgeText(r.business_name), buttons: NUDGE_BUTTONS });
      if (out.ok) {
        sent += 1;
        await recordOutbound(r.id, out.waMessageId, "sent", { kind: "interactive" });
      } else {
        log.warn({ userId: r.id, reason: out.reason }, "first-document nudge not sent");
      }
    } catch (err) {
      log.error({ err, userId: r.id }, "first-document nudge failed");
    }
  }
  if (sent) log.info({ count: sent }, "first-document nudges");
  return sent;
}
