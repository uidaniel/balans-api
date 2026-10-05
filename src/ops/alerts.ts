/**
 * Emails the team when something goes wrong (5 October 2026).
 *
 * Two kinds:
 *
 *   - Every error the API logs, gathered and sent as one digest at most every
 *     ten minutes, grouped by message with a count — so a fault that repeats
 *     a hundred times is one line, not a hundred emails.
 *   - A health check going down, at once, and again when it comes back
 *     (jobs/health.ts). Still down three hours later: said again.
 *
 * Only the log line's message and the error's own message go into an email,
 * never the rest of the log object, which can hold phone numbers, amounts and
 * payloads. A failure to send an alert is logged as a warning, not an error,
 * so it cannot feed itself back into the next digest.
 */

import type { FastifyBaseLogger } from "fastify";

import { sendEmail } from "../email/send.ts";

/** Who hears. Not secret, so not in the environment. */
export const ALERT_TO = [
  "usebalans@gmail.com",
  "dannycodesltd@gmail.com",
  "uwakblessing1@gmail.com",
  "joshuauwak1@gmail.com",
];

const DIGEST_EVERY_MS = 10 * 60_000;
const MAX_GROUPS = 40;

type Group = { message: string; count: number; first: Date; last: Date };
const errors = new Map<string, Group>();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Called by the logger for every error-level line (http/server.ts). Must
 * never throw and never log: it runs inside the logger.
 */
export function captureLogError(args: unknown[]): void {
  try {
    const [first, second] = args;
    let msg = typeof first === "string" ? first : typeof second === "string" ? second : "";
    if (first && typeof first === "object") {
      const o = first as { err?: { message?: string }; message?: string; msg?: string };
      const errMsg = o.err?.message ?? (first instanceof Error ? first.message : undefined);
      if (!msg) msg = o.msg ?? o.message ?? "";
      if (errMsg) msg = msg ? `${msg}: ${errMsg}` : errMsg;
    }
    msg = clip(msg.replace(/\s+/g, " ").trim() || "(error with no message)", 300);
    const now = new Date();
    const g = errors.get(msg);
    if (g) {
      g.count += 1;
      g.last = now;
    } else if (errors.size < MAX_GROUPS) {
      errors.set(msg, { message: msg, count: 1, first: now, last: now });
    } else {
      const other = errors.get("(other errors)") ?? { message: "(other errors)", count: 0, first: now, last: now };
      other.count += 1;
      other.last = now;
      errors.set("(other errors)", other);
    }
  } catch {
    /* an alert must never break logging */
  }
}

const lagos = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function mail(subject: string, text: string, html: string, log: FastifyBaseLogger): Promise<void> {
  for (const to of ALERT_TO) {
    const sent = await sendEmail({ to, subject, text, html }, log).catch(() => ({ ok: false as const }));
    if (!sent.ok) log.warn({ to, subject }, "alert email not sent");
  }
}

export async function sendErrorDigest(log: FastifyBaseLogger): Promise<number> {
  if (!errors.size) return 0;
  const groups = [...errors.values()].sort((a, b) => b.count - a.count);
  errors.clear();
  const total = groups.reduce((t, g) => t + g.count, 0);
  const subject = `Balans: ${total} error${total === 1 ? "" : "s"} in the API`;
  const text = [
    `${total} error${total === 1 ? "" : "s"} logged since the last digest.`,
    "",
    ...groups.map((g) => `${g.count}× ${g.message}  (${lagos(g.first)}${g.count > 1 ? ` – ${lagos(g.last)}` : ""})`),
    "",
    "Health page: https://admin.balans.ng/health",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#10231c">
<p><b>${total} error${total === 1 ? "" : "s"}</b> logged by the Balans API since the last digest.</p>
<table cellpadding="6" style="border-collapse:collapse">${groups
    .map(
      (g) =>
        `<tr style="border-top:1px solid #e4dccb"><td style="font-weight:700;white-space:nowrap">${g.count}×</td><td>${esc(g.message)}<br><span style="color:#5f6f67;font-size:12px">${lagos(g.first)}${g.count > 1 ? ` – ${lagos(g.last)}` : ""}</span></td></tr>`,
    )
    .join("")}</table>
<p style="color:#5f6f67;font-size:12px">Sent at most every 10 minutes. Same message, one line.</p></div>`;
  await mail(subject, text, html, log);
  return total;
}

/** A health check changed: down, still down, or back. */
export async function healthAlert(
  kind: "down" | "still_down" | "recovered",
  name: string,
  detail: string,
  since: Date | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const subject =
    kind === "recovered"
      ? `Balans: ${name} is working again`
      : kind === "still_down"
        ? `Balans: ${name} is still down`
        : `Balans: ${name} is down`;
  const line =
    kind === "recovered"
      ? `${name} is working again${since ? ` (it was down from ${lagos(since)})` : ""}.`
      : `${name} is ${kind === "still_down" ? "still " : ""}down${since && kind === "still_down" ? ` since ${lagos(since)}` : ""}.`;
  const text = [line, "", `Detail: ${detail}`, "", "Health page: https://admin.balans.ng/health"].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#10231c">
<p style="font-size:16px"><b>${esc(line)}</b></p><p>Detail: ${esc(detail)}</p>
<p style="color:#5f6f67;font-size:12px">From the API's health checks, every two minutes.</p></div>`;
  await mail(subject, text, html, log);
}

let timer: NodeJS.Timeout | null = null;

export function startErrorDigests(log: FastifyBaseLogger): void {
  if (timer) return;
  timer = setInterval(() => void sendErrorDigest(log).catch(() => undefined), DIGEST_EVERY_MS);
  timer.unref?.();
}

/** On shutdown: whatever has gathered goes now rather than never. */
export async function stopErrorDigests(log: FastifyBaseLogger): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await sendErrorDigest(log).catch(() => undefined);
}
