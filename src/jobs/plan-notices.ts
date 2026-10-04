/**
 * Tells somebody they are on Pro when an admin put them there.
 *
 * A paying customer hears "Pro is active" the moment their payment lands
 * (payments/notify.ts). Somebody promoted from the admin heard nothing, and
 * found out — if at all — by noticing a feature had appeared. The admin app
 * writes only to the database, so this watches `audit_log` for promotions,
 * every 15 seconds, and sends the same welcome (migration 0036).
 *
 * Each row is claimed before the message goes, so two API processes cannot
 * both send it, and a promotion undone before the tick is not announced.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { notifyProGranted } from "../payments/notify.ts";

const TICK_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function sendPlanNotices(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await db().query<{ user_id: string; plan: string; plan_expires_at: Date | null }>(
    `WITH claimed AS (
       UPDATE audit_log SET notified_at = now()
        WHERE action = 'plan.promote' AND notified_at IS NULL
          -- A promotion from days ago, caught by a long outage, is no longer news.
          AND created_at > now() - interval '1 day'
       RETURNING target_id
     )
     SELECT DISTINCT u.id AS user_id, u.plan::text AS plan, u.plan_expires_at
       FROM claimed c JOIN users u ON u.id::text = c.target_id`,
  );
  let sent = 0;
  for (const r of rows) {
    // Demoted again before we got here: nothing to announce.
    if (r.plan !== "pro") continue;
    await notifyProGranted(r.user_id, r.plan_expires_at, log);
    sent += 1;
  }
  if (sent) log.info({ count: sent }, "admin promotions announced");
  return sent;
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sendPlanNotices(log);
  } catch (err) {
    log.error({ err: (err as Error).message }, "plan notices failed");
  } finally {
    running = false;
  }
}

export function startPlanNotices(log: FastifyBaseLogger): void {
  if (timer || !env.DATABASE_URL) return;
  timer = setInterval(() => void tick(log), TICK_MS);
  timer.unref?.();
}

export function stopPlanNotices(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
