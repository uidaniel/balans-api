/**
 * The win-back (5 November 2026): once, to somebody quiet for two weeks.
 *
 * Not "we miss you". Something they can use: their last client, and the
 * same invoice again in one tap ("Invoice them again", documents/again.ts).
 * Only for somebody owed nothing, since anybody owed money already hears on
 * Mondays (jobs/weekly-owed.ts) and that is the better reason to come back.
 *
 * By email, not WhatsApp. Two weeks on the 24-hour window is long shut, and
 * a WhatsApp template asking them to use Balans is marketing whatever it is
 * called, at about ₦64 each. Email costs nothing. Still marketing in law, so
 * only to people who said yes to updates (`updates_opt_in_at`), with the
 * same Stop link as an announcement, and only to an address they confirmed.
 * Once per person, ever (`win_back_at`, claimed before it is sent).
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { sendEmail, type Email } from "../email/send.ts";
import { button, layout, paragraph } from "../email/layout.ts";
import { displayNumber } from "../whatsapp/number.ts";
import { stopUrl } from "../broadcast/announce.ts";
import { esc } from "../documents/page.ts";

export const QUIET_DAYS = 14;
/** Past this, they have moved on and a message is noise. */
const GIVE_UP_DAYS = 30;

/** What the button types into the chat for them: "invoice Zenith Homes again". */
export const againText = (client: string) => `invoice ${client} again`;

export function winBackEmail(o: { client: string; userId: string; waNumber: string | null }): Omit<Email, "to"> {
  const chat = o.waNumber ? `https://wa.me/${o.waNumber}?text=${encodeURIComponent(againText(o.client))}` : null;
  const stop = stopUrl(o.userId);
  const subject = `Need to bill ${o.client} again?`;
  return {
    sender: "support",
    subject,
    replyTo: env.SUPPORT_EMAIL,
    text: [
      subject,
      "",
      "One tap makes the same invoice you sent them last time, dated today. You check it before anything goes.",
      chat ? `\n${chat}` : `\nReply "${againText(o.client)}" to Balans on WhatsApp.`,
      "",
      `Stop Balans updates: ${stop}`,
    ].join("\n"),
    html: layout({
      preheader: "The same invoice as last time, dated today, in one tap.",
      heading: subject,
      body: [
        paragraph("One tap makes the same invoice you sent them last time, dated today. You check it before anything goes."),
        chat ? button("Invoice them again", chat) : paragraph(`Reply <strong>${esc(againText(o.client))}</strong> to Balans on WhatsApp.`),
        paragraph(`Don't want these? <a href="${esc(stop)}" style="color:inherit;">Stop Balans updates</a>. Your invoices and receipts are not affected.`, true),
      ].join("\n"),
    }),
  };
}

export async function sendWinBacks(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; email: string; client: string }>(
    `SELECT u.id, u.email, last.client
       FROM users u
       JOIN LATERAL (
         SELECT c.name AS client FROM documents d JOIN clients c ON c.id = d.client_id
          WHERE d.user_id = u.id AND d.type = 'invoice' AND d.status <> 'draft' AND d.currency = 'NGN'
            AND c.deleted_at IS NULL
          ORDER BY d.created_at DESC LIMIT 1
       ) last ON true
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND u.updates_opt_in_at IS NOT NULL
        AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL
        AND u.win_back_at IS NULL
        AND (SELECT max(m.created_at) FROM messages m WHERE m.user_id = u.id AND m.direction = 'in')
            BETWEEN now() - make_interval(days => $2::int) AND now() - make_interval(days => $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM documents o
           WHERE o.user_id = u.id AND o.type IN ('invoice', 'payment_request')
             AND o.status IN ('sent', 'viewed', 'overdue', 'part_paid')
             AND o.total_kobo > o.amount_paid_kobo
        )
      LIMIT 50`,
    [QUIET_DAYS, GIVE_UP_DAYS],
  );
  if (!rows.length) return 0;

  const waNumber = await displayNumber();
  let sent = 0;
  for (const r of rows) {
    try {
      const claim = await db().query(`UPDATE users SET win_back_at = now() WHERE id = $1 AND win_back_at IS NULL`, [r.id]);
      if (!claim.rowCount) continue;
      const out = await sendEmail({ to: r.email, ...winBackEmail({ client: r.client, userId: r.id, waNumber }) }, log);
      if ((out as { ok?: boolean })?.ok !== false) sent += 1;
    } catch (err) {
      log.error({ err, userId: r.id }, "win-back failed");
    }
  }
  if (sent) log.info({ count: sent }, "win-back emails sent");
  return sent;
}
