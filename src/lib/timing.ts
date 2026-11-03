/**
 * How long each step takes, on live (3 November 2026).
 *
 * The question was "how do we make every reply faster", and the honest first
 * answer is to know where the seconds go: reading the message, the model,
 * drawing a card or a PDF, uploading it, Meta taking it. Each step notes its
 * duration here; they are written in batches every few seconds, never on the
 * path of a reply, and the admin's Health page shows the middle and slow end
 * of each (migration 0064). Nothing about the person is kept, only the step
 * and the milliseconds.
 *
 * "reply.first" is the one people feel: from Meta handing us their message
 * to the first thing we send back being accepted. It is measured per message
 * through AsyncLocalStorage, so the send code needs no idea which message it
 * is answering.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { db } from "../db/pool.ts";

type Arrival = { at: number; replied: boolean };

const arrival = new AsyncLocalStorage<Arrival>();
const pending: { step: string; ms: number }[] = [];
let timer: NodeJS.Timeout | null = null;

const FLUSH_MS = 10_000;
/** A runaway loop must not grow this without end. */
const MAX_PENDING = 5_000;

/** Notes one duration. Never throws, never waits. */
export function note(step: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || pending.length >= MAX_PENDING) return;
  pending.push({ step: step.slice(0, 40), ms: Math.min(Math.round(ms), 2_000_000_000) });
  if (!timer) {
    timer = setTimeout(() => void flush(), FLUSH_MS);
    timer.unref();
  }
}

/** Runs `fn` and notes how long it took, whether it worked or not. */
export async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    note(step, performance.now() - start);
  }
}

/** Handles one inbound message knowing when Meta delivered it, for "reply.first". */
export function fromArrival<T>(fn: () => Promise<T>): Promise<T> {
  return arrival.run({ at: performance.now(), replied: false }, fn);
}

/** Called when Meta accepts a message we sent: the first one per inbound is the reply time. */
export function sentReply(): void {
  const a = arrival.getStore();
  if (!a || a.replied) return;
  a.replied = true;
  note("reply.first", performance.now() - a.at);
}

/** Writes what has been noted. Exported for shutdown and tests. */
export async function flush(): Promise<void> {
  timer = null;
  if (!pending.length) return;
  const batch = pending.splice(0, pending.length);
  await db()
    .query(`INSERT INTO step_timings (step, ms) SELECT * FROM unnest($1::text[], $2::int[])`, [
      batch.map((b) => b.step),
      batch.map((b) => b.ms),
    ])
    .catch(() => {
      // Timings are a nice-to-have: a failed write is dropped, not retried.
    });
}

/** For tests: what is waiting to be written. */
export const pendingTimings = (): readonly { step: string; ms: number }[] => pending;
