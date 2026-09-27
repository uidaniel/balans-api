/**
 * Sends what the admin queued: tests and the real launch message.
 *
 * The admin writes a row to `broadcasts` and one row per person to
 * `broadcast_recipients`; this picks up anything queued within seconds and
 * works through it, writing what happened to each person back onto their row
 * so the admin can show progress. See migration 0029.
 *
 * A test goes through exactly this path with one recipient, so the test
 * proves the real send. Before Meta approves the template a test can still be
 * seen: it goes as an ordinary message with the same picture, words and
 * button — which WhatsApp allows only to somebody who has written to Balans
 * in the last 24 hours, and says so when it refuses. The real send never
 * falls back like that: to the waitlist it is the approved template or
 * nothing.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { sendEmail } from "../email/send.ts";
import { sendFlow, sendTemplate } from "../whatsapp/client.ts";
import { flowId } from "../whatsapp/flows/register.ts";
import { recordTemplateStatuses } from "../whatsapp/register-templates.ts";
import { LAUNCH, LAUNCH_BANNER, launchEmail } from "../broadcast/launch.ts";
import { MARK_CID } from "../email/layout.ts";

const SITE = env.SITE_URL.replace(/\/$/, "");

const TICK_MS = 15_000;
const STATUS_EVERY_MS = 5 * 60_000;
/** Between recipients: well under Meta's 80 a second, and gentle on Resend. */
const GAP_MS = 150;

type Broadcast = { id: string; campaign: string; kind: "test" | "live"; channels: string[] };
type Recipient = { id: string; phone: string | null; email: string | null; wa_status: string; email_status: string };

let timer: NodeJS.Timeout | null = null;
let running = false;
let statuses: Record<string, string> = {};
let statusesAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The setup form's token for somebody who may not be a user yet.
 *
 * Most forms carry `<key>:<userId>`, but nobody on the waitlist has a user
 * row until they sign up. So this one carries their number instead, and the
 * form's endpoint makes the user the first time they press a button in it
 * (flows/endpoint.ts). Nothing is created for people who never tap.
 */
export const setupToken = (phone: string): string => `onboarding:wa:${phone.replace(/\D/g, "")}`;

/**
 * What the admin's preview draws, written where the admin can read it.
 *
 * The admin is another application and cannot import `LAUNCH`, so the copy
 * travels through `config`. One source: the preview cannot say something the
 * message does not.
 */
export async function publishCampaignForAdmin(): Promise<void> {
  const email = launchEmail();
  const campaign = {
    campaign: LAUNCH.campaign,
    image: LAUNCH.image,
    whatsapp: {
      body: LAUNCH.whatsapp.body,
      footer: LAUNCH.whatsapp.footer,
      button: LAUNCH.whatsapp.button.text,
      opens: "The Balans setup form, inside WhatsApp",
    },
    // The email's pictures travel as attachments (`cid:`), which a preview
    // in a browser cannot show; the site hosts public copies of the same files.
    email: {
      subject: email.subject,
      html: email.html
        .replaceAll(`cid:${MARK_CID}`, `${SITE}/broadcast/mark.png`)
        .replaceAll(`cid:${LAUNCH_BANNER.cid}`, `${SITE}/broadcast/${LAUNCH_BANNER.file}`),
    },
  };
  await db().query(
    `INSERT INTO config (key, value_json, updated_by) VALUES ($1, $2::jsonb, 'broadcast')
       ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [`broadcast.${LAUNCH.campaign}`, JSON.stringify(campaign)],
  );
}

async function templateApproved(): Promise<boolean> {
  if (Date.now() - statusesAt > STATUS_EVERY_MS) {
    statuses = (await recordTemplateStatuses().catch(() => null)) ?? statuses;
    statusesAt = Date.now();
  }
  return statuses[LAUNCH.campaign] === "APPROVED";
}

async function sendWhatsApp(b: Broadcast, r: Recipient, approved: boolean): Promise<{ status: string; via?: string; error?: string }> {
  if (!b.channels.includes("whatsapp") || !r.phone) return { status: "skipped" };

  if (approved) {
    const sent = await sendTemplate(r.phone, LAUNCH.campaign, [], {
      language: "en",
      headerImage: LAUNCH.image,
      flowToken: setupToken(r.phone),
    });
    return sent.ok ? { status: "sent", via: "template" } : { status: "failed", via: "template", error: sent.reason };
  }

  // Before approval, only a test, and only as an ordinary message.
  if (b.kind !== "test") return { status: "skipped", error: "the template is not approved by Meta yet" };
  const form = await flowId(LAUNCH.whatsapp.button.flow);
  if (!form) return { status: "failed", via: "preview", error: "the setup form has not been published yet" };
  const sent = await sendFlow(r.phone, {
    body: LAUNCH.whatsapp.body,
    cta: LAUNCH.whatsapp.button.text,
    flowId: form,
    token: setupToken(r.phone),
    screen: LAUNCH.whatsapp.button.screen,
    headerImage: LAUNCH.image,
    footer: LAUNCH.whatsapp.footer,
  });
  if (sent.ok) return { status: "sent", via: "preview" };
  return {
    status: "failed",
    via: "preview",
    error: `${sent.reason} — the template is still waiting for Meta, so a test can only reach a number that has messaged Balans in the last 24 hours. Send "hi" to Balans from this phone, then send the test again.`,
  };
}

async function sendMail(b: Broadcast, r: Recipient, log: FastifyBaseLogger): Promise<{ status: string; error?: string }> {
  if (!b.channels.includes("email") || !r.email) return { status: "skipped" };
  const sent = await sendEmail({ to: r.email, ...launchEmail() }, log);
  return sent.ok ? { status: "sent" } : { status: "failed", error: sent.reason };
}

/** One broadcast, start to finish, resuming where a restart left it. */
async function work(b: Broadcast, log: FastifyBaseLogger): Promise<void> {
  if (b.campaign !== LAUNCH.campaign) {
    await db().query(`UPDATE broadcasts SET status = 'failed', note = $2, finished_at = now() WHERE id = $1`, [
      b.id,
      `no campaign called ${b.campaign}`,
    ]);
    return;
  }

  const approved = await templateApproved();
  if (b.kind === "live" && !approved) {
    await db().query(
      `UPDATE broadcasts SET status = 'failed', note = 'the template is not approved by Meta yet; nothing was sent', finished_at = now() WHERE id = $1`,
      [b.id],
    );
    log.warn({ broadcast: b.id }, "live broadcast refused: template not approved");
    return;
  }

  let done = 0;
  for (;;) {
    const { rows } = await db().query<Recipient>(
      `SELECT id, phone, email, wa_status, email_status FROM broadcast_recipients
        WHERE broadcast_id = $1 AND (wa_status = 'pending' OR email_status = 'pending')
        ORDER BY id LIMIT 50`,
      [b.id],
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      const wa = r.wa_status === "pending" ? await sendWhatsApp(b, r, approved).catch((e: Error) => ({ status: "failed", error: e.message })) : null;
      const mail = r.email_status === "pending" ? await sendMail(b, r, log).catch((e: Error) => ({ status: "failed", error: e.message })) : null;
      await db().query(
        `UPDATE broadcast_recipients
            SET wa_status = COALESCE($2, wa_status), wa_via = COALESCE($3, wa_via), wa_error = COALESCE($4, wa_error),
                email_status = COALESCE($5, email_status), email_error = COALESCE($6, email_error),
                sent_at = now()
          WHERE id = $1`,
        [r.id, wa?.status ?? null, (wa as { via?: string } | null)?.via ?? null, wa?.error ?? null, mail?.status ?? null, mail?.error ?? null],
      );
      done += 1;
      await sleep(GAP_MS);
    }
  }

  await db().query(`UPDATE broadcasts SET status = 'done', finished_at = now() WHERE id = $1`, [b.id]);
  log.info({ broadcast: b.id, kind: b.kind, recipients: done }, "broadcast finished");
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Refresh the statuses on their own clock too, so the admin sees an
    // approval arrive even when nothing is being sent.
    await templateApproved();

    const { rows } = await db().query<Broadcast>(
      `UPDATE broadcasts SET status = 'sending', started_at = COALESCE(started_at, now())
        WHERE id = (SELECT id FROM broadcasts WHERE status IN ('queued', 'sending')
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, campaign, kind, channels`,
    );
    if (rows[0]) await work(rows[0], log);
  } catch (err) {
    log.error({ err }, "broadcast tick failed");
  } finally {
    running = false;
  }
}

export function startBroadcasts(log: FastifyBaseLogger): void {
  if (timer || !env.DATABASE_URL) return;
  void publishCampaignForAdmin().catch((err: unknown) => log.warn({ err }, "could not publish the campaign for the admin"));
  timer = setInterval(() => void tick(log), TICK_MS);
  timer.unref?.();
}

export function stopBroadcasts(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
