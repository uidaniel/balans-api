/**
 * The win-back (5 November 2026): once, to somebody quiet for two weeks.
 *
 * Not "we miss you". Something they can use: their last client, and the
 * same invoice again in one tap ("Invoice them again", documents/again.ts).
 * Only for somebody owed nothing, since anybody owed money already hears on
 * Mondays (jobs/weekly-owed.ts) and that is the better reason to come back.
 *
 * Two weeks on, the 24-hour window is long shut, so this is a template, and
 * an honest one: it is selling, so it is MARKETING, about ₦64 each. That
 * means it goes only to people who said yes to updates from Balans (the
 * unticked box at setup, `updates_opt_in_at`), as the law on marketing asks.
 * Once per person, ever (`win_back_at`, claimed before it is sent).
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { send } from "../whatsapp/outbound.ts";
import { b, para } from "../whatsapp/format.ts";
import type { ReplyButton } from "../whatsapp/client.ts";

export const QUIET_DAYS = 14;
/** Past this, they have moved on and a message is noise. */
const GIVE_UP_DAYS = 30;

export function winBackButtons(client: string): ReplyButton[] {
  return [
    { id: `invoice ${client} again`, title: "Invoice them again" },
    { id: "stop updates", title: "Stop updates" },
  ];
}

export function winBackText(client: string): string {
  return para(
    `🔁 ${b(`Need to bill ${client} again?`)}`,
    "One tap makes the same invoice, dated today, for you to check before it goes.",
  );
}

export async function sendWinBacks(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; wa_phone: string; client: string }>(
    `SELECT u.id, u.wa_phone, last.client
       FROM users u
       JOIN LATERAL (
         SELECT c.name AS client FROM documents d JOIN clients c ON c.id = d.client_id
          WHERE d.user_id = u.id AND d.type = 'invoice' AND d.status <> 'draft' AND d.currency = 'NGN'
            AND c.deleted_at IS NULL
          ORDER BY d.created_at DESC LIMIT 1
       ) last ON true
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND u.updates_opt_in_at IS NOT NULL
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

  let sent = 0;
  for (const r of rows) {
    try {
      const claim = await db().query(`UPDATE users SET win_back_at = now() WHERE id = $1 AND win_back_at IS NULL`, [r.id]);
      if (!claim.rowCount) continue;
      const buttons = winBackButtons(r.client);
      const outcome = await send(
        {
          userId: r.id,
          phone: r.wa_phone,
          text: winBackText(r.client),
          buttons,
          fallback: { template: "win_back_again", params: [r.client], payloads: buttons.map((x) => x.id) },
        },
        log,
      );
      if (outcome.kind === "sent") sent += 1;
      else log.warn({ userId: r.id, outcome }, "win-back not sent");
    } catch (err) {
      log.error({ err, userId: r.id }, "win-back failed");
    }
  }
  if (sent) log.info({ count: sent }, "win-backs sent");
  return sent;
}
