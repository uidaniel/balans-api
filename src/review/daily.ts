/**
 * The daily review of the bot's answers (5 November 2026).
 *
 * The founders asked for the bot to learn from what people say to it. A live
 * money bot should not rewrite itself, so the loop has a person in it: every
 * morning the turns from the day before that look like a wrong answer are
 * emailed to the team, with the turns around them; the team decides the fix,
 * and it goes through staging and tests like any other. No model reads them
 * (the founders' call, 5 November 2026: no spend on it for now), so it costs
 * nothing.
 *
 * What counts as "looks wrong" is cheap and in code (flagsFor): a fallback
 * reply, a reading the model failed or was unsure of, the same thing sent
 * again, a "no" or "???" straight after, a reply to one of our cards. The
 * text is masked when it is written (review/turns.ts).
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { defaults, env } from "../config.ts";
import { mailTeam } from "../ops/alerts.ts";
import { esc } from "../documents/page.ts";

/** From 7am Lagos, once a day, about the day before. */
export const REVIEW_FROM_HOUR = 7;
/** At most this many cases in the email; the ones with most flags first. */
const MAX_CASES = 60;

const FALLBACK =
  /I could not read that one|Which one\?|is not built yet|Something went wrong on our side|I only do|I cannot find|Nothing on file for|That message is too long|I don't understand|I'm not sure what you mean/i;
const PUSHBACK = /^(no+|nope|wrong|what\??|\?+|huh\??|eh\??|that'?s not|not what|i said|why\??|you didn'?t|it didn'?t|bro\b)/i;

export type Turn = {
  id: string;
  user_id: string;
  at: Date;
  kind: string;
  inbound: string | null;
  quoted: boolean;
  reply: string | null;
  intent: string | null;
  confidence: number | null;
  model: string | null;
};

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9₦]+/g, " ").trim();

/** Why a turn looks like a wrong answer, given the one after it from the same person. */
export function flagsFor(t: Turn, next: Turn | null): string[] {
  const f: string[] = [];
  if (t.reply && FALLBACK.test(t.reply)) f.push("fallback reply");
  if (t.kind === "text" && t.inbound && !t.reply) f.push("no answer");
  if (t.model?.endsWith("(failed)")) f.push("model failed");
  if (t.confidence !== null && t.confidence < env.PARSER_CONFIDENCE_MIN) f.push("model unsure");
  if (t.quoted) f.push("replied to a card");
  const soon = next && next.at.getTime() - t.at.getTime() < 3 * 60_000;
  if (soon && next.kind === "text" && t.kind === "text" && norm(next.inbound) && norm(next.inbound) === norm(t.inbound)) f.push("sent again");
  if (soon && next.inbound && PUSHBACK.test(next.inbound.trim())) f.push("pushed back after");
  return f;
}

export type Case = { case: number; flags: string[]; before: string | null; user: string; bot: string; after: string | null };

export function casesFrom(turns: Turn[]): Case[] {
  const byUser = new Map<string, Turn[]>();
  for (const t of turns) byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t]);
  const found: (Case & { weight: number })[] = [];
  for (const list of byUser.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    list.forEach((t, i) => {
      const next = list[i + 1] ?? null;
      const flags = flagsFor(t, next);
      if (!flags.length) return;
      const prev = list[i - 1];
      const near = (o: Turn | undefined | null, ms: number) => (o && Math.abs(o.at.getTime() - t.at.getTime()) < ms ? o : null);
      const p = near(prev, 30 * 60_000);
      const n = near(next, 10 * 60_000);
      found.push({
        case: 0,
        weight: flags.length,
        flags,
        before: p ? `User: ${p.inbound ?? `[${p.kind}]`}\nBot: ${p.reply ?? "(nothing)"}` : null,
        user: t.inbound ?? `[${t.kind}]`,
        bot: [t.reply ?? "(nothing)", t.intent ? `(read as: ${t.intent}${t.confidence !== null ? `, ${t.confidence}` : ""})` : ""].filter(Boolean).join("\n"),
        after: n ? `User: ${n.inbound ?? `[${n.kind}]`}\nBot: ${n.reply ?? "(nothing)"}` : null,
      });
    });
  }
  return found
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_CASES)
    .map(({ weight: _w, ...c }, i) => ({ ...c, case: i + 1 }));
}

function lagos(now: Date): { day: string; hour: number } {
  const tz = defaults.behaviour.timezone;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now));
  return { day, hour };
}

/** Once a day from 7am Lagos: yesterday's turns, flagged, reviewed, kept and emailed. */
export async function runBotReview(log: FastifyBaseLogger, now = new Date()): Promise<boolean> {
  const { day, hour } = lagos(now);
  if (hour < REVIEW_FROM_HOUR) return false;
  // Claimed first, so the hourly job runs it once.
  const claim = await db().query(`INSERT INTO bot_reviews (day) VALUES ($1) ON CONFLICT DO NOTHING RETURNING day`, [day]);
  if (!claim.rowCount) return false;

  try {
    const { rows } = await db().query<Turn & { confidence: string | null }>(
      `SELECT t.id, t.user_id, t.at, t.kind, t.inbound, t.quoted, t.reply, p.intent, p.confidence::text AS confidence, p.model
         FROM bot_turns t
         LEFT JOIN LATERAL (
           SELECT intent, confidence, model FROM parser_logs l
            WHERE l.user_id = t.user_id AND l.created_at BETWEEN t.at - interval '5 seconds' AND t.at + interval '60 seconds'
            ORDER BY l.created_at LIMIT 1
         ) p ON true
        WHERE t.at > now() - interval '24 hours'
        ORDER BY t.user_id, t.at`,
    );
    const turns: Turn[] = rows.map((r) => ({ ...r, confidence: r.confidence === null ? null : Number(r.confidence) }));
    const cases = casesFrom(turns);

    await db().query(`UPDATE bot_reviews SET turns = $2, flagged = $3, summary = $4, findings = $5 WHERE day = $1`, [
      day,
      turns.length,
      cases.length,
      cases.length ? `${cases.length} answers look wrong.` : "Nothing looked wrong.",
      JSON.stringify({ cases }),
    ]);

    if (cases.length) await emailReview(day, turns.length, cases, log);
    log.info({ day, turns: turns.length, flagged: cases.length }, "bot review");
    return true;
  } catch (err) {
    log.error({ err }, "bot review failed");
    return false;
  }
}

async function emailReview(day: string, turns: number, cases: Case[], log: FastifyBaseLogger): Promise<void> {
  const subject = `Balans bot review, ${day}: ${cases.length} ${cases.length === 1 ? "answer looks" : "answers look"} wrong, of ${turns} messages`;
  const text = [
    `${cases.length} of yesterday's ${turns} messages got an answer that looks wrong. Read each and decide the fix.`,
    "",
    ...cases.flatMap((c) => [
      `#${c.case} (${c.flags.join(", ")})`,
      ...(c.before ? [`  Before: ${c.before.replace(/\n/g, " / ")}`] : []),
      `  They said: ${c.user}`,
      `  Bot said: ${c.bot.replace(/\n/g, " / ")}`,
      ...(c.after ? [`  After: ${c.after.replace(/\n/g, " / ")}`] : []),
      "",
    ]),
  ].join("\n");
  const block = (label: string, v: string | null) =>
    v ? `<p style="margin:4px 0;color:#4b5a53"><b>${label}</b> ${esc(v).replace(/\n/g, "<br>")}</p>` : "";
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#10231c;line-height:1.5">
<p style="font-size:16px"><b>${cases.length} of yesterday's ${turns} messages got an answer that looks wrong.</b> Read each and decide the fix.</p>
${cases
  .map(
    (c) => `<div style="border:1px solid #e5ded0;border-radius:12px;padding:12px 14px;margin:10px 0">
<p style="margin:0 0 6px;font-size:12px;color:#8a6a10"><b>#${c.case}</b> · ${esc(c.flags.join(", "))}</p>
${block("Before:", c.before)}${block("They said:", c.user)}${block("Bot said:", c.bot)}${block("After:", c.after)}</div>`,
  )
  .join("")}
<p style="color:#5f6f67;font-size:12px">Flagged by rules, not read by a model. Numbers, emails and links are masked. Kept in bot_reviews.</p></div>`;
  await mailTeam(subject, text, html, log);
}
