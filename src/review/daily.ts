/**
 * The daily review of the bot's answers (5 November 2026).
 *
 * The founders asked for the bot to learn from what people say to it. A model
 * cannot retrain on our chats, and a live money bot should not rewrite itself,
 * so the loop has a person in it: every morning the turns from the day before
 * that look like a wrong answer are read by a model, which says what the
 * person wanted, what the bot did, and the fix; the team gets that by email
 * and decides; the fix goes through staging and tests like any other.
 *
 * What counts as "looks wrong" is cheap and in code (flagsFor): a fallback
 * reply, a reading the model failed or was unsure of, the same thing sent
 * again, a "no" or "???" straight after, a reply to one of our cards. The
 * text is masked when it is written (review/turns.ts), so the model sees what
 * was meant and none of the numbers.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { defaults, env } from "../config.ts";
import { mailTeam } from "../ops/alerts.ts";
import { esc } from "../documents/page.ts";

/** From 7am Lagos, once a day, about the day before. */
export const REVIEW_FROM_HOUR = 7;
/** At most this many cases to the model; the ones with most flags first. */
const MAX_CASES = 60;
const MODEL = "claude-opus-5-5";

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

const SYSTEM = `You review conversations with Balans, a WhatsApp bot that Nigerian freelancers and small businesses use to send invoices, quotes and payment requests, get paid by bank transfer or card, chase late payers, and see who owes them. People type in plain English, Nigerian English or Pidgin, or tap buttons (shown as [buttons: ...]). Numbers, emails and links are masked.

Each case is one message the bot may have answered wrongly, with the turn before and after it when there was one, and why it was flagged. For each case decide whether the bot's answer was wrong or unhelpful for what the person wanted. A fallback reply is not automatically wrong: it is right when the message really was unclear or off-topic. Be specific and practical: name the exact phrase the bot should understand, the reply it should have given, or the bug. Do not invent features; if the person wanted something Balans does not do, say so as a product gap.

Keep every field to one or two plain sentences. Then give a short summary for the founders and the patterns that repeat across cases, most costly first.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "patterns", "findings"],
  properties: {
    summary: { type: "string", description: "Two or three sentences for the founders." },
    patterns: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["case", "wrong", "wanted", "bot_did", "fix_type", "fix", "priority"],
        properties: {
          case: { type: "integer" },
          wrong: { type: "boolean" },
          wanted: { type: "string" },
          bot_did: { type: "string" },
          fix_type: { type: "string", enum: ["new phrase", "reply wording", "parser", "bug", "product gap", "none"] },
          fix: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

const Review = z.object({
  summary: z.string(),
  patterns: z.array(z.string()),
  findings: z.array(
    z.object({
      case: z.number().int(),
      wrong: z.boolean(),
      wanted: z.string(),
      bot_did: z.string(),
      fix_type: z.string(),
      fix: z.string(),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
});
export type Review = z.infer<typeof Review>;

/** One call: the cases in, the review out. Null when the model declined or answered off-schema. */
export async function reviewCases(cases: Case[], log: FastifyBaseLogger): Promise<Review | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Routed to another model on a policy decline rather than nothing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(cases) }],
  } as never);
  const msg = res as unknown as { stop_reason: string; content: { type: string; text?: string }[]; usage?: unknown };
  if (msg.stop_reason === "refusal") {
    log.warn("bot review declined by the model");
    return null;
  }
  const text = msg.content.find((b) => b.type === "text")?.text;
  if (!text) return null;
  const parsed = Review.safeParse(JSON.parse(text));
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.slice(0, 3) }, "bot review came back off-schema");
    return null;
  }
  log.info({ usage: msg.usage, cases: cases.length }, "bot review done");
  return parsed.data;
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
    const review = cases.length ? await reviewCases(cases, log) : null;
    const wrong = review ? review.findings.filter((f) => f.wrong) : [];

    await db().query(
      `UPDATE bot_reviews SET turns = $2, flagged = $3, summary = $4, findings = $5 WHERE day = $1`,
      [
        day,
        turns.length,
        cases.length,
        review?.summary ?? (cases.length ? "The review did not come back; the cases are kept." : "Nothing looked wrong."),
        JSON.stringify(review ? { patterns: review.patterns, findings: review.findings, cases } : { cases }),
      ],
    );

    if (turns.length) await emailReview(day, turns.length, cases, review, wrong, log);
    log.info({ day, turns: turns.length, flagged: cases.length, wrong: wrong.length }, "bot review");
    return true;
  } catch (err) {
    log.error({ err }, "bot review failed");
    return false;
  }
}

async function emailReview(
  day: string,
  turns: number,
  cases: Case[],
  review: Review | null,
  wrong: Review["findings"],
  log: FastifyBaseLogger,
): Promise<void> {
  const subject = `Balans bot review, ${day}: ${wrong.length} wrong ${wrong.length === 1 ? "answer" : "answers"} of ${turns} messages`;
  const order = { high: 0, medium: 1, low: 2 } as const;
  const ranked = [...wrong].sort((a, b) => order[a.priority] - order[b.priority]);
  const byCase = new Map(cases.map((c) => [c.case, c]));
  const text = [
    review?.summary ?? `${cases.length} flagged; the model review did not come back.`,
    "",
    ...(review?.patterns.length ? ["Patterns:", ...review.patterns.map((p) => `- ${p}`), ""] : []),
    ...ranked.flatMap((f) => {
      const c = byCase.get(f.case);
      return [
        `[${f.priority}] ${f.fix_type}: ${f.fix}`,
        `  They said: ${c?.user ?? "?"}`,
        `  Bot said: ${(c?.bot ?? "?").split("\n")[0]}`,
        `  They wanted: ${f.wanted}`,
        "",
      ];
    }),
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#10231c;line-height:1.5">
<p style="font-size:16px"><b>${esc(review?.summary ?? `${cases.length} flagged; the model review did not come back.`)}</b></p>
${review?.patterns.length ? `<p><b>Patterns</b></p><ul>${review.patterns.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
${ranked
  .map((f) => {
    const c = byCase.get(f.case);
    return `<div style="border:1px solid #e5ded0;border-radius:12px;padding:12px 14px;margin:10px 0">
<p style="margin:0 0 6px"><b>${esc(f.priority)} · ${esc(f.fix_type)}</b>: ${esc(f.fix)}</p>
<p style="margin:0;color:#4b5a53">They said: <i>${esc(c?.user ?? "?")}</i><br>Bot said: <i>${esc((c?.bot ?? "?").split("\n")[0]!.slice(0, 240))}</i><br>They wanted: ${esc(f.wanted)}</p></div>`;
  })
  .join("")}
<p style="color:#5f6f67;font-size:12px">${turns} messages yesterday, ${cases.length} flagged, ${wrong.length} judged wrong. Text is masked. Kept in bot_reviews.</p></div>`;
  await mailTeam(subject, text, html, log);
}
