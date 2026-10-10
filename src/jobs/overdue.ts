/**
 * The jobs that run while nobody is watching (PRD F13, F6).
 *
 * Three of them, all idempotent, all safe to run twice:
 *
 *   - Mark invoices overdue the day after they were due (F13, section 6).
 *   - Prompt the user about each one, once, at the due date and again at 3 and
 *     7 days (F13). Free plan gets the first only.
 *   - Discard drafts nobody confirmed within 24 hours (F6).
 *
 * Everything is driven off the database rather than a timer in memory, so a
 * restart loses nothing and two processes running at once cannot double-send:
 * the `reminders` row is claimed before the message goes out.
 */

import { tellPayouts } from "../payments/payouts.ts";
import { proPriceForPhone } from "../billing/price.ts";
import { checkSubaccounts, emailUnverifiedDigest } from "../payments/subaccount-verification.ts";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { refreshAll } from "../fx/rate.ts";
import { defaults, env } from "../config.ts";
import { formatFriendly, formatISO, todayIn, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { b, block, lines, para, row } from "../whatsapp/format.ts";
import { send } from "../whatsapp/outbound.ts";
import { sendMonthlySummaries } from "./monthly-summary.ts";
import { sweepStaleDrafts } from "../documents/store.ts";
import { retireSupersededAccounts } from "../settings/bank-change.ts";
import {
  claimProReminder,
  expireLapsedSubscriptions,
  GRACE_DAYS,
  proRemindersDue,
  releaseProReminder,
  type ProStage,
} from "../billing/subscription.ts";
import { proEnded, proEndingSoon, proGraceEnding, proLapsed, proWinBack } from "../billing/messages.ts";
import { proStartToken, proStartUrl } from "../billing/pro-link.ts";
import type { TemplateName } from "../whatsapp/window.ts";
import { payBy } from "../documents/summary.ts";
import { bankDetailsOf, type BankDetails } from "../documents/bank-details.ts";
import { emailReminderToClient } from "../email/client-reminder.ts";
import { amountFor, whatsappReminderToClient } from "../documents/client-whatsapp.ts";

/* -------------------------------------------------------------------------- */
/* Quiet hours (F13)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * "No reminders between 8pm and 8am Africa/Lagos."
 *
 * A reminder is a nudge, not an emergency, and one at 3am costs more goodwill
 * than it recovers. Checked in Lagos time regardless of where the server is,
 * because the rule is about the person's evening and not the server's.
 */
export function withinQuietHours(now = new Date(), tz = defaults.behaviour.timezone): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now),
  );
  const { quietHoursStart, quietHoursEnd } = defaults.behaviour;
  // The window wraps midnight, so it is "at or after 20:00, or before 08:00".
  return hour >= quietHoursStart || hour < quietHoursEnd;
}

/* -------------------------------------------------------------------------- */
/* Marking things overdue                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Section 6: sent or viewed becomes overdue the day after the due date.
 *
 * Not on the due date itself — an invoice due Friday is not late on Friday,
 * and a client who pays that afternoon should never have seen it marked late.
 */
export async function markOverdue(today: Civil, log: FastifyBaseLogger): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE documents
        SET status = 'overdue'
      WHERE status IN ('sent', 'viewed')
        AND type IN ('invoice', 'payment_request')
        AND due_date IS NOT NULL
        AND due_date < $1::date
        AND total_kobo > amount_paid_kobo`,
    [formatISO(today)],
  );
  if (rowCount) log.info({ count: rowCount }, "invoices marked overdue");
  return rowCount ?? 0;
}

/** Quotes stop being good after their validity date (F5). */
export async function expireQuotes(today: Civil, log: FastifyBaseLogger): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE documents
        SET status = 'expired'
      WHERE status IN ('sent', 'viewed')
        AND type = 'quote'
        AND valid_until IS NOT NULL
        AND valid_until < $1::date`,
    [formatISO(today)],
  );
  if (rowCount) log.info({ count: rowCount }, "quotes expired");
  return rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                  */
/* -------------------------------------------------------------------------- */

/** F13: at the due date, then 3 and 7 days after. Keep REMINDER_KINDS in documents/actions.ts in step. */
export const SCHEDULE: { kind: string; daysAfterDue: number; proOnly: boolean }[] = [
  { kind: "due", daysAfterDue: 0, proOnly: false },
  { kind: "late_3", daysAfterDue: 3, proOnly: true },
  { kind: "late_7", daysAfterDue: 7, proOnly: true },
];

/**
 * Writes the reminder rows that are due, without sending anything.
 *
 * Scheduling and sending are separate so a send failure does not lose the
 * schedule, and so the same row cannot be created twice: the unique-ish
 * combination of document, channel and kind is checked before insert.
 */
export async function scheduleReminders(today: Civil, log: FastifyBaseLogger): Promise<number> {
  let made = 0;

  for (const step of SCHEDULE) {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO reminders (document_id, channel, kind, scheduled_at, status)
       SELECT d.id, 'whatsapp', $2, now(), 'pending'
         FROM documents d
         JOIN users u ON u.id = d.user_id
        WHERE d.type IN ('invoice', 'payment_request')
          AND d.status IN ('sent', 'viewed', 'overdue')
          AND d.total_kobo > d.amount_paid_kobo
          AND d.due_date IS NOT NULL
          AND d.due_date + ($3 || ' days')::interval <= $1::date
          AND u.status = 'active'
          -- Free plan gets the prompt at the due date only (F13).
          AND ($4::boolean = false OR u.plan = 'pro')
          AND NOT EXISTS (
            SELECT 1 FROM reminders r
             WHERE r.document_id = d.id AND r.kind = $2 AND r.channel = 'whatsapp'
          )
       RETURNING id`,
      [formatISO(today), step.kind, String(step.daysAfterDue), step.proOnly],
    );
    made += rows.length;
  }

  if (made) log.info({ count: made }, "reminders scheduled");
  return made;
}

/**
 * Sends what is pending, one message per invoice.
 *
 * Each row is claimed with a conditional update before the send, so two
 * workers cannot both pick it up. A failed send leaves it `failed` rather than
 * back in the queue: a reminder that could not go out today is not worth
 * sending at midnight, and the next run will schedule the next step anyway.
 */
export async function sendDueReminders(
  today: Civil,
  log: FastifyBaseLogger,
  limit = 100,
): Promise<number> {
  if (withinQuietHours()) {
    log.info("within quiet hours; no reminders sent");
    return 0;
  }

  const { rows } = await db().query<{
    id: string;
    kind: string;
    document_id: string;
    user_id: string;
    wa_phone: string;
    number: number | null;
    total_kobo: number;
    amount_paid_kobo: number;
    due_date: Date;
    public_token: string | null;
    client_name: string;
    business_name: string | null;
    subtotal_kobo: number;
    vat_kobo: number;
    currency: string;
    original_amount_minor: number | null;
  }>(
    `SELECT r.id, r.kind, d.id AS document_id, d.user_id, u.wa_phone,
            d.number, d.total_kobo, d.amount_paid_kobo, d.due_date, d.public_token,
            d.subtotal_kobo, d.vat_kobo, d.currency, d.original_amount_minor,
            c.name AS client_name, u.business_name
       FROM reminders r
       JOIN documents d ON d.id = r.document_id
       JOIN users u     ON u.id = d.user_id
       JOIN clients c   ON c.id = d.client_id
      WHERE r.status = 'pending' AND r.channel = 'whatsapp'
        -- A suspended or deleted sender's clients are not chased.
        AND u.status = 'active'
        -- Paid or cancelled since it was scheduled: F13 says each stops.
        AND d.status IN ('sent', 'viewed', 'overdue')
        AND d.total_kobo > d.amount_paid_kobo
      ORDER BY r.scheduled_at
      LIMIT $1`,
    [limit],
  );

  let sent = 0;

  for (const r of rows) {
    // Claim it first. Whoever wins the update owns the send.
    const claimed = await db().query(
      `UPDATE reminders SET status = 'sending' WHERE id = $1 AND status = 'pending'`,
      [r.id],
    );
    if (claimed.rowCount === 0) continue;

    /*
     * One reminder that throws must not end the hour (9 October 2026): it
     * used to stay 'sending' for ever and take every job after it down too.
     */
    try {
      const owed = r.total_kobo - r.amount_paid_kobo;
      // Nothing paid yet on a dollar invoice: still owed in dollars. Part paid,
      // the rest is only known in naira, which is what was charged.
      const owedAgreed = r.currency !== "NGN" && r.amount_paid_kobo === 0 ? amountFor(r) : undefined;
      const due: Civil = {
        y: r.due_date.getFullYear(),
        m: r.due_date.getMonth() + 1,
        d: r.due_date.getDate(),
      };
      const link = r.public_token
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${r.public_token}`
        : null;

      /*
       * The client first, then the freelancer — told what already happened.
       *
       * The freelancer used to be handed a message to copy and forward
       * ("Send them this"), which is the step that gets forgotten, and the
       * reason reminders exist at all. Where Balans can reach the client
       * itself it does, and the freelancer hears that it did. Only where it
       * cannot — no address and no number, or a Free plan — are they still
       * given the words to send.
       *
       * Each channel independent of the other: a bounced email must not stop
       * the WhatsApp, and neither depends on the freelancer's phone.
       */
      const isToday = due.y === today.y && due.m === today.m && due.d === today.d;
      const emailed = await emailReminderToClient(r.document_id, today, log).catch((err: unknown) => {
        log.error({ err, documentId: r.document_id }, "client reminder email failed");
        return false;
      });
      const whatsapped = await whatsappReminderToClient(
        r.document_id,
        isToday ? "today" : formatFriendly(due, today),
        log,
      ).catch((err: unknown) => {
        log.error({ err, documentId: r.document_id }, "client reminder WhatsApp failed");
        return { ok: false as const };
      });
      const reminded = { email: emailed, whatsapp: whatsapped.ok };
      const how = remindedHow(reminded);

      const outcome = await send(
        {
          userId: r.user_id,
          phone: r.wa_phone,
          text: promptMessage({
            number: r.number,
            clientName: r.client_name,
            businessName: r.business_name ?? "us",
            owedKobo: owed,
            due,
            today,
            link,
            bank: await bankDetailsOf(r.document_id),
            owedAgreed,
            reminded,
          }),
          fallback: how
            ? {
                template: "client_reminded",
                params: [
                  r.client_name,
                  r.number === null ? "" : String(r.number),
                  owedAgreed ?? formatNaira(owed),
                  how,
                ],
              }
            : {
                template: "invoice_overdue_prompt",
                params: [
                  r.number === null ? "" : String(r.number),
                  owedAgreed ?? formatNaira(owed),
                  formatFriendly(due, today),
                  r.client_name,
                ],
              },
        },
        log,
      );

      await db().query(
        `UPDATE reminders SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
          WHERE id = $1`,
        [r.id, outcome.kind === "sent" ? "sent" : outcome.kind === "skipped" ? "skipped" : "failed"],
      );

      if (outcome.kind === "sent") sent += 1;
    } catch (err) {
      log.error({ err, reminderId: r.id }, "reminder failed");
      await db()
        .query(`UPDATE reminders SET status = 'failed' WHERE id = $1 AND status = 'sending'`, [r.id])
        .catch(() => undefined);
    }
  }

  if (sent) log.info({ count: sent }, "reminders sent");
  return sent;
}

/**
 * "by email", "on WhatsApp", "by email and on WhatsApp", or null for neither.
 *
 * One function for the chat message and the template, so the two can never
 * describe the same reminder differently.
 */
export function remindedHow(r: { email: boolean; whatsapp: boolean }): string | null {
  if (r.email && r.whatsapp) return "by email and on WhatsApp";
  if (r.email) return "by email";
  if (r.whatsapp) return "on WhatsApp";
  return null;
}

/**
 * The prompt, with a message the user can forward as it stands.
 *
 * F13: "a ready-to-forward polite message and the link", and the design system
 * asks for neutral wording. Neutral means it does not accuse anybody of
 * anything — most late invoices are forgotten, not refused, and a sharp
 * reminder costs a client relationship worth more than the invoice.
 */
export function promptMessage(x: {
  number: number | null;
  clientName: string;
  businessName: string;
  owedKobo: number;
  due: Civil;
  today: Civil;
  link: string | null;
  /** The account a naira invoice was sent with; replaces the link. */
  bank?: BankDetails | null;
  /** What is owed in dollars or pounds, on an invoice priced in them. */
  owedAgreed?: string;
  /** How Balans reached the client itself, if it did. */
  reminded?: { email: boolean; whatsapp: boolean };
}): string {
  const which = x.number === null ? "INVOICE" : `INVOICE #${x.number}`;
  const when = formatFriendly(x.due, x.today);
  const owed = x.owedAgreed ?? formatNaira(x.owedKobo);
  /*
   * The first reminder goes on the due date itself, and an invoice due today
   * is not late. "IS LATE ... was due today" told the sender their client
   * had missed a date they still had hours to meet, and handed them a
   * message saying the same to the client.
   */
  const today =
    x.due.y === x.today.y && x.due.m === x.today.m && x.due.d === x.today.d;

  /*
   * The part meant for the client, kept plain.
   *
   * It used to be wrapped in italics to mark it as a quotation. WhatsApp only
   * italicises within a line, so five lines wrapped in underscores showed the
   * underscores — "_Hi Joshua Uwak," at the top and "Thank you._" at the
   * bottom, exactly as typed. Rules above and below do the same job and
   * survive a line break.
   *
   * No possessive either. "Daniel Adventures's invoice" is what a naive
   * apostrophe-s does to a name already ending in s, and it goes to somebody
   * else's client.
   */
  // "us" is the fallback when the user never named their business. "the
  // invoice from us" reads like a ransom note, so drop the clause entirely.
  const from = x.businessName === "us" ? "" : ` from ${x.businessName}`;

  const heading = block(`⏰ ${b(today ? `${which} IS DUE TODAY` : `${which} IS LATE`)}`, [
    row("Client", x.clientName),
    row("Amount", b(owed)),
    ...(today ? [] : [row("Was due", when)]),
  ]);

  /*
   * Already reminded: say so, and say how. Nothing to copy, nothing to
   * forward — the whole point of sending it for them.
   */
  const how = x.reminded ? remindedHow(x.reminded) : null;
  if (how) {
    return para(
      heading,
      `✅ ${b(`${x.clientName} has been reminded ${how}`)}, with the link to pay.`,
      "Nothing for you to do. I will tell you the moment it is paid.",
      `Reply ${b(x.number === null ? "stop reminders" : `stop reminders ${x.number}`)} to turn these off for this invoice.`,
    );
  }

  const forward = para(
    today
      ? `Hi ${x.clientName} — a quick note that the invoice${from} for ${owed} is due today.`
      : `Hi ${x.clientName} — a quick note that the invoice${from} for ${owed} was due ${when}.`,
    x.bank ? payBy(x.link, x.bank) : x.link ? `Pay here: ${x.link}` : "",
    "Thank you.",
  );

  return para(
    heading,
    // The rules here were doing real work rather than decorating \u2014 they
    // marked where the copyable message stopped. Its own paragraph says the
    // same thing: a blank line above and below it, and the instruction
    // naming what to copy.
    `${b("Send them this")} \u2014 copy the message below:`,
    forward,
    `Or reply ${b(x.number === null ? "stop reminders" : `stop reminders ${x.number}`)} to turn these off for this invoice.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Pro renewals (F18)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The Pro reminders: one before the month ends, then after it (see
 * `ProStage` in billing/subscription.ts for the schedule and why).
 *
 * Each is claimed in `pro_reminders` before it is sent and the claim given
 * back if it fails, so it goes exactly once however it goes. Checking the
 * messages table for a template name, as this used to, missed every one sent
 * as ordinary text inside the 24-hour window, and those went every hour.
 */
async function sendProStage(stage: ProStage, log: FastifyBaseLogger): Promise<number> {
  const due = await proRemindersDue(stage);
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: defaults.behaviour.timezone, day: "numeric", month: "long" }).format(d);
  let sent = 0;

  for (const r of due) {
    if (!(await claimProReminder(r.userId, r.expiresAt, stage))) continue;

    const graceEnds = new Date(r.expiresAt.getTime() + GRACE_DAYS * 86_400_000);
    // Their own price outside Nigeria (billing/price.ts).
    const p = await proPriceForPhone(r.waPhone, log);
    const price = p.label;
    const free = String(defaults.plans.free.documentsPerMonth);
    const words: { text: string; label: string; template: TemplateName; params: string[] } = {
      ending_soon: {
        text: proEndingSoon(r.expiresAt, p),
        label: "Renew Pro",
        template: "pro_ending_pay" as TemplateName,
        params: [dayOf(r.expiresAt), price],
      },
      ended: {
        text: proEnded(r.expiresAt, p),
        label: "Renew Pro",
        template: "pro_ended_pay" as TemplateName,
        params: [dayOf(r.expiresAt), dayOf(graceEnds), price],
      },
      grace_ending: {
        text: proGraceEnding(r.expiresAt, p),
        label: "Keep Pro",
        template: "pro_last_day_pay" as TemplateName,
        params: [dayOf(graceEnds), price],
      },
      lapsed: { text: proLapsed(p), label: "Get Pro back", template: "pro_free_pay" as TemplateName, params: [free, price] },
      win_back: { text: proWinBack(p), label: "Get Pro back", template: "pro_free_pay" as TemplateName, params: [free, price] },
    }[stage];

    // The same signed link the chat's Pay button opens: a fresh Paystack
    // checkout for this person, renewal included (see renewalOpen).
    const outcome = await send(
      {
        userId: r.userId,
        phone: r.waPhone,
        text: words.text,
        cta: { label: words.label, url: proStartUrl(r.userId) },
        fallback: { template: words.template, params: words.params, urlSuffix: proStartToken(r.userId) },
      },
      log,
    );
    if (outcome.kind === "sent") sent += 1;
    else await releaseProReminder(r.userId, r.expiresAt, stage);
  }

  if (sent) log.info({ stage, count: sent }, "pro reminders sent");
  return sent;
}

async function sendProReminders(log: FastifyBaseLogger): Promise<void> {
  if (withinQuietHours()) return;
  for (const stage of ["ending_soon", "ended", "grace_ending"] as const) await sendProStage(stage, log);
}

/** After the move to Free, which has to have happened first. */
async function sendLapsedReminders(log: FastifyBaseLogger): Promise<void> {
  if (withinQuietHours()) return;
  for (const stage of ["lapsed", "win_back"] as const) await sendProStage(stage, log);
}

/* -------------------------------------------------------------------------- */

/** Everything that runs on a tick, in the order it has to happen. */
export async function runDailyJobs(log: FastifyBaseLogger): Promise<void> {
  const today = todayIn(defaults.behaviour.timezone);
  try {
    await markOverdue(today, log);
    await expireQuotes(today, log);
    await scheduleReminders(today, log);
    await sendDueReminders(today, log);
    const dropped = await sweepStaleDrafts(24);
    if (dropped) log.info({ count: dropped }, "stale drafts discarded");
    // A scheduled bank change that has come into force supersedes the old
    // account; this is what stops three of them sitting there as 'active'.
    const retired = await retireSupersededAccounts();
    if (retired) log.info({ count: retired }, "superseded bank accounts retired");

    await sendProReminders(log);
    await expireLapsedSubscriptions(log);
    await sendLapsedReminders(log);

    // F15. Returns early on every day but the 1st.
    await sendMonthlySummaries(today, log);

    /*
     * The naira rate, kept warm (International PRD section 6).
     *
     * So the first person to invoice abroad in the morning is not the one
     * waiting on somebody else's API, and — the real reason — so a provider
     * outage shows up in the logs an hour before it shows up as a freelancer
     * being told they cannot send an invoice.
     *
     * Last, and only when the feature is on. It talks to the network and a
     * rate nobody can use must not stand in front of the reminders.
     */
    if (env.INTL_ENABLED) await refreshAll(log);

    // Paystack holds payouts to unverified subaccounts indefinitely. Keep
    // their status current for the admin, and tell the admins daily while
    // any are waiting (payments/subaccount-verification.ts).
    if (env.PAYSTACK_SECRET_KEY) {
      await checkSubaccounts(log);
      await emailUnverifiedDigest(log);
      // Paystack sends no webhook when it pays a subaccount out: ask.
      await tellPayouts(log);
    }
  } catch (err) {
    // A failed run must not stop the next one.
    log.error({ err }, "daily jobs failed");
  }
}
