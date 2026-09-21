/**
 * When the jobs run (PRD section 3: "Postgres-backed job queue").
 *
 * A timer inside the API process, not a separate worker. That is the right
 * size for one server and a private beta, and it is honest about what it is:
 * the jobs themselves are idempotent and claim their own work in the database,
 * so moving them to a real worker later changes where this loop lives and
 * nothing about the jobs.
 *
 * Two things keep it from misbehaving. A run never overlaps itself, so a slow
 * run cannot pile up behind a fast tick. And an advisory lock means two API
 * processes on the same database elect one to do the work, rather than both
 * sending every reminder.
 */

import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { runDailyJobs } from "./overdue.ts";

/**
 * An arbitrary constant, shared by every process that runs these jobs.
 *
 * Postgres advisory locks are keyed by a number and namespaced by nothing, so
 * this has to be distinctive enough not to collide with anything else that
 * might take one on the same database.
 */
const LOCK_KEY = 0x62616c61; // "bala"

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Runs the jobs if no other process is already doing so.
 *
 * `pg_try_advisory_lock` returns immediately rather than queueing, which is
 * what we want: a tick that finds somebody else working should skip, not wait
 * around to do the same work again a moment later.
 */
async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) {
    log.warn("previous job run still going; skipping this tick");
    return;
  }
  running = true;

  let client: PoolClient | null = null;

  try {
    // Inside the try, not before it. Supabase's pooler drops connections, and
    // a failure here used to escape as an unhandled rejection and take the
    // whole API down with it — a background job must never be able to do that.
    client = await db().connect();

    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      log.debug("another process holds the job lock; skipping");
      return;
    }

    try {
      await runDailyJobs(log);
    } finally {
      // A lock we cannot release is not worth crashing over: an advisory lock
      // is tied to the session and dies with it anyway.
      await client
        .query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
        .catch((err: unknown) => log.warn({ err }, "could not release the job lock"));
    }
  } catch (err) {
    log.error({ err }, "job tick failed");
  } finally {
    try {
      client?.release();
    } catch {
      /* already gone */
    }
    running = false;
  }
}

/**
 * Starts the loop.
 *
 * Hourly rather than daily. The work is bounded and idempotent, and an hourly
 * tick means an invoice that falls due at 9am is chased that morning rather
 * than a day later — while quiet hours still keep anything from going out
 * overnight.
 */
export function startScheduler(log: FastifyBaseLogger): void {
  if (timer) return;
  if (!env.JOBS_ENABLED) {
    log.info("background jobs are disabled");
    return;
  }

  // Not immediately: let the server finish coming up and answer a health
  // check before it starts doing work.
  const fire = () => {
    tick(log).catch((err: unknown) => log.error({ err }, "job tick threw"));
  };

  const first = setTimeout(fire, 30_000);
  first.unref();

  timer = setInterval(fire, env.JOBS_INTERVAL_MS);
  // The timer must never be the reason the process stays alive.
  timer.unref();

  log.info({ everyMs: env.JOBS_INTERVAL_MS }, "background jobs started");
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
