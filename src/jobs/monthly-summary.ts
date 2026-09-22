/**
 * The summary that goes out on the 1st (PRD F15).
 *
 * The month a freelancer has just had, in one message, unprompted. It is the
 * only thing Balans sends that is not about a particular invoice, and the only
 * reason someone who has not billed anyone in three weeks opens the chat.
 *
 * Three rules shape it.
 *
 * It goes to people who did something. A summary saying you invoiced nobody
 * and were paid nothing is a message somebody is charged for, to be told what
 * they already knew — and from October the charge is real.
 *
 * It goes once. The daily job runs hourly, so "is it the 1st?" is true twelve
 * times; `monthly_summaries` is keyed on the month being summarised, so the
 * second attempt writes nothing and sends nothing.
 *
 * And it is recorded before it is sent. A crash between the two costs somebody
 * a summary; a crash the other way round costs them twelve.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { previousMonth } from "../../core/period.ts";
import { formatISO, type Civil } from "../../core/dates.ts";
import { summarise } from "../documents/queries.ts";
import { summaryMessage } from "../documents/reports.ts";
import { send } from "../whatsapp/outbound.ts";

/**
 * Sends last month's summary to everyone who had a month worth summarising.
 *
 * Returns how many went out, so the job log says something useful on a day
 * when nothing happened.
 */
export async function sendMonthlySummaries(
  today: Civil,
  log: FastifyBaseLogger,
): Promise<number> {
  // Only at the turn of the month. Every other day this costs one comparison.
  if (today.d !== 1) return 0;

  const period = previousMonth(today);
  const from = formatISO(period.from);
  const to = formatISO(period.to);

  /*
   * Who gets one: an active user who issued or was paid for something last
   * month, and has not already had it.
   *
   * The NOT EXISTS is belt to the primary key's braces — it keeps the work
   * down on the twelfth run of the day rather than doing it and discarding it.
   */
  const { rows } = await db().query<{ id: string; wa_phone: string }>(
    `SELECT u.id, u.wa_phone
       FROM users u
      WHERE u.status = 'active'
        AND EXISTS (
          SELECT 1 FROM documents d
           WHERE d.user_id = u.id
             AND d.status <> 'draft'
             AND d.issue_date BETWEEN $1 AND $2
        )
        AND NOT EXISTS (
          SELECT 1 FROM monthly_summaries s
           WHERE s.user_id = u.id AND s.period_start = $1
        )
      ORDER BY u.created_at`,
    [from, to],
  );

  if (!rows.length) {
    log.info({ period: period.label }, "no summaries to send");
    return 0;
  }

  let sent = 0;

  for (const user of rows) {
    try {
      const summary = await summarise(user.id, period, today);

      /*
       * Claimed before it is sent.
       *
       * If this insert wins, nobody else sends it; if the send then fails,
       * they miss one summary. The other order risks sending the same summary
       * on every tick for an hour, which is worse and costs money.
       */
      const claim = await db().query(
        `INSERT INTO monthly_summaries (user_id, period_start, paid_kobo, documents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, period_start) DO NOTHING
         RETURNING user_id`,
        [user.id, from, summary.paidKobo, summary.documents],
      );
      if (!claim.rows.length) continue;

      const outcome = await send(
        {
          userId: user.id,
          phone: user.wa_phone,
          text: summaryMessage(summary),
          // Outside the window this is a template, and a template cannot carry
          // the whole summary — so it carries the headline and invites them in,
          // where the free-form version is waiting.
          fallback: {
            template: "monthly_summary_ready",
            params: [period.label, formatNaira(summary.paidKobo), String(summary.documents)],
          },
        },
        log,
      );

      if (outcome.kind === "sent") sent += 1;
    } catch (err) {
      // One user's summary failing must not stop everybody else's.
      log.error({ err, userId: user.id }, "could not send a monthly summary");
    }
  }

  log.info({ period: period.label, considered: rows.length, sent }, "monthly summaries sent");
  return sent;
}
