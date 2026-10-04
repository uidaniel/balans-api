/**
 * Checks everything Balans depends on, every two minutes, for the admin.
 *
 * Each check answers ok, warn or down with a line saying why, and the latest
 * answers are kept in `service_health` (migration 0038), which the admin's
 * Health page reads. Every check is cheap and read-only — nothing here sends a
 * message, charges a card or spends a model call — and each has its own
 * timeout, so one slow provider cannot hold up the rest.
 *
 * No secret ever goes into a row: a key is described by its kind ("live key"),
 * never by any part of it.
 */

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { db } from "../db/pool.ts";
import { rendererAvailable, renderPng } from "../pdf/chrome.ts";
import { lastTickAt } from "./scheduler.ts";

const EVERY_MS = 2 * 60_000;
const TIMEOUT_MS = 8_000;

export type Status = "ok" | "warn" | "down";
export type Result = { status: Status; detail: string };
type Check = { name: string; run: () => Promise<Result> };

const ago = (d: Date): string => {
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const CHECKS: Check[] = [
  {
    name: "Database",
    run: async () => {
      await db().query("SELECT 1");
      return { status: "ok", detail: "Answering queries" };
    },
  },
  {
    // Through Cloudflare and Caddy, as a client's phone reaches us.
    name: "Public URL",
    run: async () => {
      const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok
        ? { status: "ok", detail: `${new URL(url).host} answers` }
        : { status: "down", detail: `${new URL(url).host} answered ${res.status}` };
    },
  },
  {
    name: "WhatsApp API",
    run: async () => {
      if (!env.WA_ACCESS_TOKEN || !env.WA_PHONE_NUMBER_ID) return { status: "down", detail: "Not configured" };
      const { status, body } = await getJson(
        `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}?fields=verified_name,quality_rating,messaging_limit_tier,name_status`,
        { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      );
      const b = (body ?? {}) as Record<string, unknown> & { error?: { message?: string } };
      if (status !== 200) return { status: "down", detail: b.error?.message ?? `Meta answered ${status}` };
      const quality = String(b.quality_rating ?? "UNKNOWN");
      const detail = [
        b.verified_name ? `${b.verified_name}` : null,
        `quality ${quality}`,
        b.messaging_limit_tier ? `limit ${String(b.messaging_limit_tier).replace("TIER_", "")}` : null,
        b.name_status ? `name ${b.name_status}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return { status: quality === "GREEN" || quality === "UNKNOWN" ? "ok" : "warn", detail };
    },
  },
  {
    // Not a fault when quiet, only information: when we last heard from Meta.
    name: "WhatsApp webhook",
    run: async () => {
      const { rows } = await db().query<{ at: Date | null }>(
        `SELECT max(created_at) AS at FROM messages WHERE direction = 'in'`,
      );
      const at = rows[0]?.at;
      return { status: "ok", detail: at ? `Last message in ${ago(at)}` : "No messages yet" };
    },
  },
  {
    name: "Paystack",
    run: async () => {
      const key = env.PAYSTACK_SECRET_KEY;
      if (!key) return { status: "down", detail: "Not configured" };
      const kind = key.startsWith("sk_live_") ? "live key" : "test key";
      const { status, body } = await getJson(`${env.PAYSTACK_BASE_URL.replace(/\/$/, "")}/balance`, {
        authorization: `Bearer ${key}`,
      });
      if (status !== 200) {
        const msg = (body as { message?: string } | null)?.message;
        return { status: "down", detail: `${kind} · ${msg ?? `answered ${status}`}` };
      }
      const live = kind === "live key";
      return {
        status: live || env.NODE_ENV !== "production" ? "ok" : "warn",
        detail: live ? "Live key working" : "Test key: payments are not real",
      };
    },
  },
  {
    name: "Email (Resend)",
    run: async () => {
      const key = process.env.RESEND_API_KEY;
      if (!key) return { status: "warn", detail: "Not configured: emails are only logged" };
      const { status, body } = await getJson("https://api.resend.com/domains", { authorization: `Bearer ${key}` });
      if (status !== 200) return { status: "down", detail: `Resend answered ${status}` };
      const domains = ((body as { data?: { name: string; status: string }[] } | null)?.data ?? []).map(
        (d) => `${d.name} ${d.status}`,
      );
      const bad = domains.some((d) => !d.endsWith(" verified"));
      return { status: bad ? "warn" : "ok", detail: domains.join(" · ") || "No domains" };
    },
  },
  {
    // The model behind reading messages. Listing models costs nothing.
    name: "Message reader (Claude)",
    run: async () => {
      if (!env.ANTHROPIC_API_KEY) return { status: "warn", detail: "Not configured: pattern reader only" };
      const { status } = await getJson("https://api.anthropic.com/v1/models?limit=1", {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      });
      return status === 200
        ? { status: "ok", detail: `Key working · ${env.PARSER_MODEL}` }
        : { status: "down", detail: `Anthropic answered ${status}` };
    },
  },
  {
    name: "Exchange rates",
    run: async () => {
      if (!env.INTL_ENABLED) return { status: "ok", detail: "International invoicing is off" };
      const { rows } = await db().query<{ pair: string; rate: string; fetched_at: Date }>(
        `SELECT DISTINCT ON (pair) pair, rate, fetched_at FROM fx_rates ORDER BY pair, fetched_at DESC`,
      );
      if (!rows.length) return { status: "down", detail: "No rates fetched yet" };
      const stale = rows.filter((r) => Date.now() - r.fetched_at.getTime() > env.FX_STALE_MAX_HOURS * 3_600_000);
      const usd = rows.find((r) => r.pair === "USDNGN");
      const newest = rows.reduce((a, r) => (r.fetched_at > a ? r.fetched_at : a), rows[0]!.fetched_at);
      return {
        status: stale.length ? "warn" : "ok",
        detail: [
          usd ? `$1 = ₦${Math.round(Number(usd.rate)).toLocaleString("en-NG")}` : null,
          `${rows.length} currencies, newest ${ago(newest)}`,
          stale.length ? `stale: ${stale.map((r) => r.pair.slice(0, 3)).join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    },
  },
  {
    // A real render, tiny: the thing every invoice PDF depends on.
    name: "PDF renderer",
    run: async () => {
      if (!rendererAvailable()) return { status: "down", detail: "Chrome not found" };
      const png = await Promise.race([
        renderPng("<p>ok</p>", 40, 20),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), TIMEOUT_MS)),
      ]);
      return { status: png.length > 0 ? "ok" : "down", detail: "Chrome rendering" };
    },
  },
  {
    name: "Background jobs",
    run: async () => {
      if (!env.JOBS_ENABLED) return { status: "warn", detail: "Disabled" };
      if (!lastTickAt) return { status: "ok", detail: "Waiting for the first run" };
      const late = Date.now() - lastTickAt.getTime() > env.JOBS_INTERVAL_MS * 2 + 60_000;
      return { status: late ? "warn" : "ok", detail: `Last run ${ago(lastTickAt)}` };
    },
  },
];

export async function runHealthChecks(log: FastifyBaseLogger): Promise<void> {
  await Promise.all(
    CHECKS.map(async (c) => {
      const started = Date.now();
      let r: Result;
      try {
        r = await c.run();
      } catch (err) {
        r = { status: "down", detail: (err as Error).message.slice(0, 200) };
      }
      const ms = Date.now() - started;
      await db()
        .query(
          `INSERT INTO service_health (name, status, latency_ms, detail, checked_at, last_ok_at)
           VALUES ($1, $2, $3, $4, now(), CASE WHEN $2 = 'ok' THEN now() END)
           ON CONFLICT (name) DO UPDATE
             SET status = EXCLUDED.status, latency_ms = EXCLUDED.latency_ms, detail = EXCLUDED.detail,
                 checked_at = now(),
                 last_ok_at = CASE WHEN EXCLUDED.status = 'ok' THEN now() ELSE service_health.last_ok_at END`,
          [c.name, r.status, ms, r.detail.slice(0, 300)],
        )
        .catch((err: unknown) => log.warn({ err, check: c.name }, "could not record a health check"));
      if (r.status === "down") log.warn({ check: c.name, detail: r.detail }, "health check down");
    }),
  );
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startHealthChecks(log: FastifyBaseLogger): void {
  if (timer || !env.DATABASE_URL) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runHealthChecks(log);
    } finally {
      running = false;
    }
  };
  // After boot has settled, then every two minutes.
  setTimeout(() => void tick(), 20_000).unref?.();
  timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.();
}

export function stopHealthChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
