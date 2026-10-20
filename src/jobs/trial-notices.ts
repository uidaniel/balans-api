/**
 * The email to somebody whose free documents are used and who has gone quiet
 * (20 October 2026). See `trialUsedEmail` for what it says and why once.
 *
 * Who gets it: an active account with a verified email, not paying, all its
 * free documents sent, the last of them at least two days ago (and not more
 * than two weeks, so a long outage of this job does not wake somebody who
 * left a month ago), and nothing typed to Balans in those two days. Somebody
 * still talking to the chat is already being told, by the chat.
 *
 * Marked before it is sent, so two runs, or a crash after the send, cannot
 * make it two emails. A send that fails is not retried: a late "your free
 * invoices are used" is worse than none.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { drawLimitCard } from "../billing/limit-card.ts";
import { proStartUrl } from "../billing/pro-link.ts";
import { perMonthOf, proPriceFor } from "../billing/price.ts";
import { sendEmail, trialUsedEmail } from "../email/send.ts";

/** At most this many an hour, so a backlog drains rather than floods. */
const BATCH = 25;

export async function sendTrialNotices(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; email: string; business_name: string | null; allowance: number }>(
    `WITH due AS (
       SELECT u.id
         FROM users u
         LEFT JOIN conversations c ON c.user_id = u.id
        WHERE u.trial_notice_at IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL
          AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL
          AND NOT balans_paid(u)
          AND balans_trial_used(u.id) >= u.trial_documents
          AND COALESCE(c.last_inbound_at, '-infinity') < now() - interval '2 days'
          AND (SELECT max(COALESCE(d.sent_at, d.created_at)) FROM documents d
                WHERE d.user_id = u.id AND d.trial AND d.type <> 'sample'
                  AND d.status <> 'draft' AND d.parent_id IS NULL)
              BETWEEN now() - interval '14 days' AND now() - interval '2 days'
        LIMIT ${BATCH}
     )
     UPDATE users u SET trial_notice_at = now()
       FROM due WHERE u.id = due.id AND u.trial_notice_at IS NULL
     RETURNING u.id, u.email, u.business_name, u.trial_documents AS allowance`,
  );

  let sent = 0;
  for (const r of rows) {
    try {
      const [month, year] = await Promise.all([proPriceFor(r.id, log), proPriceFor(r.id, log, "year")]);
      const card = await drawLimitCard(r.id, r.allowance).catch(() => null);
      const out = await sendEmail(
        {
          to: r.email,
          ...trialUsedEmail({
            businessName: r.business_name,
            allowance: r.allowance,
            card: card?.png ?? null,
            yearLabel: year.label,
            perMonth: perMonthOf(year),
            monthLabel: month.label,
            yearUrl: proStartUrl(r.id, "year"),
            monthUrl: proStartUrl(r.id, "month"),
          }),
        },
        log,
      );
      if (out.ok) sent += 1;
      else log.warn({ userId: r.id, reason: out.reason }, "trial notice not sent");
    } catch (e) {
      log.error({ userId: r.id, err: (e as Error).message }, "trial notice failed");
    }
  }
  if (rows.length) log.info({ due: rows.length, sent }, "trial notices");
  return sent;
}

/**
 * Message text, cleared after the retention period (privacy policy: "deleted
 * after 30 days by a job that runs daily"). The row stays, without its text,
 * because the counts in it are how the assistant's daily limit is kept.
 */
export async function purgeParserText(days: number): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE parser_logs SET text = NULL
      WHERE text IS NOT NULL AND created_at < now() - make_interval(days => $1::int)`,
    [days],
  );
  return rowCount ?? 0;
}
