/**
 * Monday's "who owes you" (5 November 2026).
 *
 * Almost nobody sends in their second week. Money still owed is the one
 * reason to open Balans that is about them and not about us, so on Monday
 * morning anybody owed money is told how much and by how many clients, with
 * the list a tap away. Nobody with nothing owed hears anything.
 *
 * Inside the 24-hour window it is a message; outside, the `weekly_owed`
 * template, which is a fact about their account and so a utility message.
 * Once a week (`weekly_owed_at`, claimed before it is sent), never on the
 * 1st, when the monthly summary already says what is outstanding, and never
 * again after "Stop weekly updates".
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { send } from "../whatsapp/outbound.ts";
import { b, para } from "../whatsapp/format.ts";
import type { ReplyButton } from "../whatsapp/client.ts";
import type { Civil } from "../../core/dates.ts";
import { defaults } from "../config.ts";

/** From 9am on Monday, Lagos time. Quiet hours are checked by the caller. */
export const WEEKLY_OWED_FROM_HOUR = 9;

/** An invoice younger than this is not "owed" yet in any sense worth a message. */
const OLDER_THAN_DAYS = 2;

export const WEEKLY_OWED_BUTTONS: ReplyButton[] = [
  { id: "who owes me", title: "Who owes me" },
  { id: "stop weekly updates", title: "Stop weekly updates" },
];

/** Monday, at or after 9am in Lagos. */
export function weeklyOwedDue(now: Date, tz = defaults.behaviour.timezone): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Mon" && hour >= WEEKLY_OWED_FROM_HOUR;
}

export type Owed = { totalKobo: number; clients: number; invoices: number; late: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function weeklyOwedText(o: Owed): string {
  const late = o.late === 0 ? "" : o.late === o.invoices ? (o.invoices === 1 ? ", and it's late" : ", all of them late") : `, ${o.late} of them late`;
  return para(
    `📅 ${b(`You're owed ${formatNaira(o.totalKobo)}`)}`,
    `From ${plural(o.clients, "client", "clients")}, on ${plural(o.invoices, "unpaid invoice", "unpaid invoices")}${late}. Tap below to see who.`,
  );
}

export async function sendWeeklyOwed(today: Civil, now: Date, log: FastifyBaseLogger): Promise<number> {
  if (today.d === 1 || !weeklyOwedDue(now)) return 0;

  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    total: string;
    clients: number;
    invoices: number;
    late: number;
  }>(
    `SELECT u.id, u.wa_phone,
            sum(d.total_kobo - d.amount_paid_kobo)::text AS total,
            count(DISTINCT d.client_id)::int AS clients,
            count(*)::int AS invoices,
            count(*) FILTER (WHERE d.due_date < $1::date)::int AS late
       FROM users u
       JOIN documents d ON d.user_id = u.id
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND u.weekly_owed_off_at IS NULL
        AND (u.weekly_owed_at IS NULL OR u.weekly_owed_at < now() - interval '6 days')
        AND d.type IN ('invoice', 'payment_request')
        AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid')
        AND d.total_kobo > d.amount_paid_kobo
        AND d.created_at < now() - make_interval(days => $2::int)
      GROUP BY u.id
      LIMIT 500`,
    [`${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`, OLDER_THAN_DAYS],
  );

  let sent = 0;
  for (const r of rows) {
    try {
      const claim = await db().query(
        `UPDATE users SET weekly_owed_at = now()
          WHERE id = $1 AND (weekly_owed_at IS NULL OR weekly_owed_at < now() - interval '6 days')`,
        [r.id],
      );
      if (!claim.rowCount) continue;
      const owed: Owed = { totalKobo: Number(r.total), clients: r.clients, invoices: r.invoices, late: r.late };
      const outcome = await send(
        {
          userId: r.id,
          phone: r.wa_phone,
          text: weeklyOwedText(owed),
          buttons: WEEKLY_OWED_BUTTONS,
          fallback: {
            template: "weekly_owed",
            params: [formatNaira(owed.totalKobo), String(owed.invoices)],
            payloads: WEEKLY_OWED_BUTTONS.map((x) => x.id),
          },
        },
        log,
      );
      if (outcome.kind === "sent") sent += 1;
      else log.warn({ userId: r.id, outcome }, "weekly owed not sent");
    } catch (err) {
      log.error({ err, userId: r.id }, "weekly owed failed");
    }
  }
  if (sent) log.info({ count: sent }, "weekly owed sent");
  return sent;
}

/** "Stop weekly updates" and back. */
export async function setWeeklyOwed(userId: string, on: boolean): Promise<void> {
  await db().query(`UPDATE users SET weekly_owed_off_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1`, [userId, on]);
}
