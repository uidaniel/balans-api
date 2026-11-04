/**
 * Messages Meta accepted and then could not deliver (4 November 2026).
 *
 * A send is "ok" once Meta takes it; whether it reached the phone comes back
 * seconds later as a delivery report. A failed one was stored and nothing
 * more, so a day of WhatsApp billing failures went unseen. Now each failure is
 * logged as an error, which the error digest emails, and a billing failure
 * also sends its own alert straight away, at most once an hour.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { whatsappPaymentAlert } from "../ops/alerts.ts";

/** Meta's code for "Business eligibility payment issue". */
const PAYMENT_CODES = new Set([131042]);
const ALERT_EVERY_MS = 60 * 60_000;
let lastPaymentAlert = 0;

type Failure = { code: number | null; title: string; recipient: string | null };

/** The failures in one webhook's status events. */
export function failuresIn(events: { type: string; payload: unknown }[]): Failure[] {
  const out: Failure[] = [];
  for (const e of events) {
    if (e.type !== "status.failed") continue;
    const st = (e.payload as { status?: { recipient_id?: string; errors?: { code?: number; title?: string; message?: string }[] } })
      .status;
    const err = st?.errors?.[0];
    out.push({
      code: typeof err?.code === "number" ? err.code : null,
      title: String(err?.title ?? err?.message ?? "unknown reason"),
      recipient: st?.recipient_id ?? null,
    });
  }
  return out;
}

export const isPaymentFailure = (f: Failure): boolean => (f.code !== null && PAYMENT_CODES.has(f.code)) || /payment/i.test(f.title);

/** Logs each failure and raises the billing alert when one is about payment. Never throws. */
export function noteDeliveryFailures(events: { type: string; payload: unknown }[], log: FastifyBaseLogger, now: number = Date.now()): void {
  for (const f of failuresIn(events)) {
    // The reason in the message, so the digest groups them; only the last
    // digits of the number, which is enough to find it and no more.
    // An error on live, which the digest emails; a warning on staging, where
    // the test account fails paid messages by design.
    const say = env.DATABASE_SCHEMA ? log.warn.bind(log) : log.error.bind(log);
    say({ code: f.code, to: f.recipient ? `…${f.recipient.slice(-4)}` : null }, `WhatsApp message failed: ${f.title}`);
    // Live only: the test account has no payment method, so on staging every
    // paid message fails this way and the alert would be noise every hour.
    if (!env.DATABASE_SCHEMA && isPaymentFailure(f) && now - lastPaymentAlert > ALERT_EVERY_MS) {
      lastPaymentAlert = now;
      void whatsappPaymentAlert(`${f.title}${f.code ? ` (code ${f.code})` : ""}`, log).catch(() => {});
    }
  }
}
