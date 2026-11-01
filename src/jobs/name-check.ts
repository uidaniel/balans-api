/**
 * "Is this your business name?" (1 November 2026).
 *
 * Setup took whatever was typed into a box labelled "Business", and some
 * finished accounts went out on their invoices as a greeting, a sentence, or
 * a name that is plainly not what they meant. 0053 cleared the ones still in
 * setup; finished accounts were left alone, because a name somebody has been
 * invoicing under is theirs to change, not ours. So this asks.
 *
 * Everybody who finished setup is asked once, a day after they finished.
 * A name that still looks wrong (`looksWrong`) is asked again every week,
 * four times at most. "Yes, that's it" or any rename settles it for good
 * (`business_name_confirmed_at`).
 *
 * In the chat with two buttons while the window is open; outside it, the
 * `business_name_check` template, once Meta has approved it as utility.
 * Neither possible means nobody is claimed, so the approval still finds
 * them. Claimed before it is sent, so two runs cannot make it two.
 *
 * Quiet hours are kept by the caller (overdue.ts).
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { nameProblem } from "../conversation/machine.ts";
import { recordOutbound } from "../conversation/store.ts";
import { sendButtons, sendTemplate, type ReplyButton } from "../whatsapp/client.ts";
import { b, para } from "../whatsapp/format.ts";
import { TEMPLATE_LANGUAGE, TEMPLATES, windowFor } from "../whatsapp/window.ts";
import { mayUseReminder } from "./setup-nudges.ts";

const BATCH = 25;
/** How often a name that looks wrong is asked, in all. */
export const MAX_CHECKS = 4;

export const NAME_BUTTONS: ReplyButton[] = [
  { id: "name is right", title: "Yes, that's it" },
  { id: "change business name", title: "Change it" },
];

/**
 * Whether a finished account's name still looks like a mistake.
 *
 * Everything setup now refuses (`nameProblem`), and the shapes that got past
 * the old form: a sentence, a name with "my", "I am" or "test" in it, a
 * single letter.
 */
export function looksWrong(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (nameProblem(n)) return true;
  if (n.replace(/[^\p{L}]/gu, "").length < 2) return true;
  if (n.split(" ").length > 6) return true;
  return /\b(?:i am|i'?m|my name|my business|testing|test)\b/i.test(n);
}

export function nameCheckText(name: string): string {
  return para(
    `📝 ${b(`Is ${name} your business name?`)}`,
    "It goes at the top of every invoice and receipt your clients see.",
  );
}

async function templateUsable(): Promise<boolean> {
  const name = TEMPLATES.business_name_check.name;
  const { rows } = await db()
    .query<{ status: string | null; category: string | null }>(
      `SELECT (SELECT value_json ->> $1 FROM config WHERE key = 'template_status')   AS status,
              (SELECT value_json ->> $1 FROM config WHERE key = 'template_category') AS category`,
      [name],
    )
    .catch(() => ({ rows: [] as { status: string | null; category: string | null }[] }));
  return mayUseReminder(rows[0]?.status, rows[0]?.category);
}

export async function sendNameChecks(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ id: string; wa_phone: string; business_name: string; name_checks: number }>(
    `SELECT u.id, u.wa_phone, u.business_name, u.name_checks
       FROM users u
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND u.consented_at IS NOT NULL AND u.consented_at < now() - interval '1 day'
        AND u.business_name IS NOT NULL
        AND u.business_name_confirmed_at IS NULL
        AND u.name_checks < $1
        AND (u.name_check_at IS NULL OR u.name_check_at < now() - interval '7 days')
      ORDER BY u.name_checks, u.consented_at
      LIMIT 200`,
    [MAX_CHECKS],
  );

  const template = await templateUsable();
  let sent = 0;
  let tried = 0;

  for (const r of rows) {
    if (tried >= BATCH) break;
    // Asked once already and it looks fine: that was the only time.
    if (r.name_checks >= 1 && !looksWrong(r.business_name)) continue;

    try {
      const open = (await windowFor(r.id)).open;
      if (!open && !template) continue;

      const claim = await db().query(
        `UPDATE users SET name_check_at = now(), name_checks = name_checks + 1
          WHERE id = $1 AND business_name_confirmed_at IS NULL
            AND (name_check_at IS NULL OR name_check_at < now() - interval '7 days')
          RETURNING id`,
        [r.id],
      );
      if (!claim.rows.length) continue;
      tried += 1;

      const out = open
        ? await sendButtons(r.wa_phone, { body: nameCheckText(r.business_name), buttons: NAME_BUTTONS })
        : await sendTemplate(r.wa_phone, TEMPLATES.business_name_check.name, [r.business_name], {
            language: TEMPLATE_LANGUAGE,
            payloads: NAME_BUTTONS.map((x) => x.id),
          });

      if (out.ok) {
        sent += 1;
        await recordOutbound(
          r.id,
          out.waMessageId,
          "sent",
          open
            ? { kind: "interactive" }
            : { inWindow: false, kind: "template", template: TEMPLATES.business_name_check.name },
        );
      } else {
        log.warn({ userId: r.id, reason: out.reason }, "name check not sent");
      }
    } catch (e) {
      log.error({ userId: r.id, err: (e as Error).message }, "name check failed");
    }
  }
  if (tried) log.info({ tried, sent, template }, "name checks");
  return sent;
}
