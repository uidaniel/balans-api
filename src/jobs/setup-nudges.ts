/**
 * Somebody who started setting up and stopped (30 October 2026).
 *
 * Until now nothing reached out. Their place was kept (store.ts holds a
 * part-finished setup past the usual 24 hours), but they only found it again
 * by writing to Balans themselves. Two touches, then nothing:
 *
 * 1. In the chat, a few hours after they went quiet, while WhatsApp still
 *    lets us write freely. The form again if they stopped on the form, or the
 *    question they stopped on if they were typing. Free, and it lands where
 *    they left off.
 *
 * 2. Two days on, if they still have not finished: the `setup_reminder`
 *    template (outside the window it is that or nothing) and an email, when
 *    there is an address we may use. Not later than two weeks, so a long
 *    outage of this job does not wake somebody who left a month ago.
 *
 * Each is claimed in the database before it is sent, like the trial notice,
 * so two runs or a crash after a send cannot make it two. A send that fails
 * is not retried: a late "your setup is waiting" is worse than none.
 *
 * Quiet hours are kept by the caller (overdue.ts), like every other job that
 * writes to people.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { onboardingHelp, WELCOME_CARD, type State } from "../conversation/machine.ts";
import { recordOutbound } from "../conversation/store.ts";
import { sendEmail, setupReminderEmail } from "../email/send.ts";
import { sendFlow, sendTemplate, sendText } from "../whatsapp/client.ts";
import { flowId } from "../whatsapp/flows/register.ts";
import { b, para } from "../whatsapp/format.ts";
import { displayNumber } from "../whatsapp/number.ts";
import { TEMPLATE_LANGUAGE, TEMPLATES, windowFor } from "../whatsapp/window.ts";

/** At most this many of each an hour, so a backlog drains rather than floods. */
const BATCH = 25;

const HEADLINE = `\u{1F44B} ${b("Your Balans setup is nearly done.")}`;

/**
 * The words of the first nudge, by where they stopped.
 *
 * On the form: the form again, with this above it. Typing: the question they
 * were on, which `onboardingHelp` already words for every step, so the nudge
 * and the chat's own help can never disagree about what comes next.
 */
export function nudgeText(state: State, form: boolean): string {
  if (state === "onboarding:form") {
    return form
      ? para(HEADLINE, "It takes about a minute. Tap below to finish, then send your first invoice in one line.")
      : // No published form: the typed questions are the way, and at this
        // state whatever they send next is taken as the business name.
        para(HEADLINE, `Send the name your clients would recognise, like ${b("Kemi Adeyemi Studio")}, and we will finish in the chat.`);
  }
  return para(HEADLINE, onboardingHelp(state));
}

/** Nudge 1: in the chat, a few hours after they went quiet. */
export async function sendSetupNudges(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; wa_phone: string; state: State }>(
    `WITH due AS (
       SELECT u.id, c.state
         FROM users u
         JOIN conversations c ON c.user_id = u.id
        WHERE u.setup_nudge_at IS NULL
          AND u.activated_setup_at IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL
          AND c.state LIKE 'onboarding%'
          AND c.last_inbound_at BETWEEN now() - interval '20 hours' AND now() - interval '3 hours'
        LIMIT ${BATCH}
     )
     UPDATE users u SET setup_nudge_at = now()
       FROM due WHERE u.id = due.id AND u.setup_nudge_at IS NULL
     RETURNING u.id, u.wa_phone, due.state`,
  );

  let sent = 0;
  for (const r of rows) {
    try {
      // The window is measured from the messages themselves, which is what
      // Meta goes by; the conversation's clock only chose who to look at.
      if (!(await windowFor(r.id)).open) {
        log.info({ userId: r.id }, "setup nudge skipped: the window has closed");
        continue;
      }

      const id = r.state === "onboarding:form" ? await flowId("onboarding") : null;
      const out = id
        ? await sendFlow(r.wa_phone, {
            body: nudgeText(r.state, true),
            cta: "Finish setup",
            flowId: id,
            token: `onboarding:${r.id}`,
            screen: "BUSINESS",
            headerImage: WELCOME_CARD,
            draft: env.WA_FLOWS_DRAFT === "true",
          })
        : await sendText(r.wa_phone, nudgeText(r.state, false));

      if (out.ok) {
        sent += 1;
        await recordOutbound(r.id, out.waMessageId, "sent", { kind: id ? "interactive" : "text" });
      } else {
        log.warn({ userId: r.id, reason: out.reason }, "setup nudge not sent");
      }
    } catch (e) {
      log.error({ userId: r.id, err: (e as Error).message }, "setup nudge failed");
    }
  }
  if (rows.length) log.info({ due: rows.length, sent }, "setup nudges");
  return sent;
}

/** Whether Meta has approved the follow-up template yet. */
async function reminderApproved(): Promise<boolean> {
  const { rows } = await db()
    .query<{ s: string | null }>(`SELECT value_json ->> $1 AS s FROM config WHERE key = 'template_status'`, [
      TEMPLATES.setup_reminder.name,
    ])
    .catch(() => ({ rows: [] as { s: string | null }[] }));
  return rows[0]?.s === "APPROVED";
}

/**
 * Nudge 2: two days on, by template and by email.
 *
 * Only somebody one of the two can reach is claimed. Before Meta approves the
 * template, a person with no address we may use is left alone rather than
 * marked, so the approval still finds them inside the two weeks.
 *
 * The address: the one they proved during setup, or else the one they gave
 * the waitlist with this number, unless they have unsubscribed from it. An
 * address typed into setup and never proved is not used: it may be a typo,
 * and then this goes to a stranger.
 */
export async function sendSetupFollowups(log: FastifyBaseLogger): Promise<number> {
  const approved = await reminderApproved();

  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    business_name: string | null;
    email: string | null;
  }>(
    `WITH found AS (
       SELECT u.id,
              COALESCE(
                CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END,
                (SELECT w.email FROM waitlist w
                  WHERE w.email IS NOT NULL AND w.unsubscribed_at IS NULL
                    AND regexp_replace(w.phone, '\\D', '', 'g') = regexp_replace(u.wa_phone, '\\D', '', 'g')
                  ORDER BY w.created_at DESC LIMIT 1)
              ) AS email
         FROM users u
         LEFT JOIN conversations c ON c.user_id = u.id
        WHERE u.setup_followup_at IS NULL
          AND u.activated_setup_at IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL
          -- No conversation is somebody who only ever tapped the launch form.
          AND (c.state IS NULL OR c.state LIKE 'onboarding%')
          AND GREATEST(COALESCE(c.last_inbound_at, '-infinity'), u.created_at)
              BETWEEN now() - interval '14 days' AND now() - interval '2 days'
     ),
     due AS (
       SELECT id, email FROM found WHERE $1::boolean OR email IS NOT NULL LIMIT ${BATCH}
     )
     UPDATE users u SET setup_followup_at = now()
       FROM due WHERE u.id = due.id AND u.setup_followup_at IS NULL
     RETURNING u.id, u.wa_phone, u.business_name, due.email`,
    [approved],
  );
  if (!rows.length) return 0;

  const waNumber = await displayNumber();
  let sent = 0;
  for (const r of rows) {
    try {
      if (approved) {
        const out = await sendTemplate(r.wa_phone, TEMPLATES.setup_reminder.name, [], {
          language: TEMPLATE_LANGUAGE,
          headerImage: WELCOME_CARD,
          flowToken: `onboarding:${r.id}`,
        });
        if (out.ok) {
          sent += 1;
          await recordOutbound(r.id, out.waMessageId, "sent", {
            inWindow: false,
            kind: "template",
            template: TEMPLATES.setup_reminder.name,
          });
        } else {
          log.warn({ userId: r.id, reason: out.reason }, "setup follow-up template not sent");
        }
      }

      if (r.email) {
        const out = await sendEmail(
          { to: r.email, ...setupReminderEmail({ businessName: r.business_name, waNumber }) },
          log,
        );
        if (out.ok) sent += 1;
        else log.warn({ userId: r.id, reason: out.reason }, "setup follow-up email not sent");
      }
    } catch (e) {
      log.error({ userId: r.id, err: (e as Error).message }, "setup follow-up failed");
    }
  }
  log.info({ due: rows.length, sent, approved }, "setup follow-ups");
  return sent;
}
