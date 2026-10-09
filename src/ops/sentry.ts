/**
 * Errors to Sentry (9 October 2026), beside the email digest, not instead.
 *
 * Fed from the same place as the digest: every `log.error` and `log.fatal`
 * passes through the logger hook in http/server.ts, so nothing has to be
 * wired route by route and nothing logged as an error can be missed. Off
 * unless SENTRY_DSN is set, so tests and local runs send nothing.
 *
 * What leaves is the message and the error, never the log object around it:
 * those carry client names, emails, phone numbers and document tokens, and
 * pino's redaction happens after this hook, not before. Emails, long digit
 * runs and /i/ /settings/ tokens are scrubbed from what does go.
 */

import * as Sentry from "@sentry/node";
import { env } from "../config.ts";

let on = false;

const scrub = (s: string): string =>
  s
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s-]{8,}\d/g, "[number]")
    .replace(/\/(i|settings|signature|summary|designs|pro\/start)\/[A-Za-z0-9_-]{8,}/g, "/$1/[token]")
    .replace(/([?&](t|token)=)[^&\s]+/g, "$1[token]");

export function initSentry(): void {
  if (on || !env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.DATABASE_SCHEMA ? "staging" : env.NODE_ENV,
    // Errors only. No tracing, no request bodies, no IP addresses.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: "warn" })],
    beforeSend(event) {
      if (event.message) event.message = scrub(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrub(ex.value);
      }
      delete event.request;
      delete event.user;
      return event;
    },
  });
  on = true;
}

/** One logged error, as the logger hook hands it over. */
export function reportToSentry(args: unknown[]): void {
  if (!on) return;
  try {
    const [first, second] = args;
    const msg = typeof first === "string" ? first : typeof second === "string" ? second : "error";
    const o = first && typeof first === "object" ? (first as { err?: unknown }) : null;
    const err = first instanceof Error ? first : o?.err instanceof Error ? o.err : null;
    if (err) {
      Sentry.captureException(err, { extra: { log: scrub(msg) } });
    } else {
      // Grouped by the message itself: it is a fixed string at every call site.
      Sentry.captureMessage(scrub(msg), "error");
    }
  } catch {
    // Reporting an error must never become one.
  }
}

/** On shutdown, so the last errors are not lost with the process. */
export async function flushSentry(): Promise<void> {
  if (on) await Sentry.flush(2000).catch(() => undefined);
}
