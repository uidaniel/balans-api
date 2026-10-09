/**
 * HTTP surface. Stateless: anything that outlives a request belongs in Postgres
 * or the job queue (PRD section 3).
 */

import rateLimit from "@fastify/rate-limit";
import { captureLogError } from "../ops/alerts.ts";
import { reportToSentry } from "../ops/sentry.ts";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { env, isProd } from "../config.ts";
import { healthRoutes } from "./routes/health.ts";
import { brandRoutes } from "./routes/brand.ts";
import { whatsappRoutes } from "./routes/whatsapp.ts";
import { publicRoutes } from "./routes/public.ts";
import { flowRoutes } from "./routes/flows.ts";
import { proRoutes } from "./routes/pro.ts";
import { paystackRoutes } from "./routes/paystack.ts";
import { templateRoutes } from "./routes/templates.ts";
import { signatureRoutes } from "./routes/signature.ts";
import { settingsPageRoutes } from "./routes/settings-page.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The exact bytes received, kept for signature checks. */
    rawBody?: Buffer;
  }
}

/**
 * Things that must never reach the logs (section 11): full account numbers,
 * verification codes, tokens, and message text.
 */
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  "*.account_number",
  "*.accountNumber",
  "*.access_token",
  "*.accessToken",
  "*.code",
  "*.otp",
  "*.text",
];

export function buildServer(): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    // Section 11: structured logs with request ids.
    genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT, remove: true },
      // Every error line also goes to the team's email digest (ops/alerts.ts).
      hooks: {
        logMethod(args, method, level) {
          if (level >= 50) {
            captureLogError(args);
            reportToSentry(args);
          }
          return method.apply(this, args);
        },
      },
      ...(isProd ? {} : { transport: { target: "pino-pretty" } }),
    },
    bodyLimit: 1_048_576, // 1 MB; webhook payloads are far smaller.
  });

  /**
   * Keep the raw body alongside the parsed one.
   *
   * Every inbound webhook is signed over the bytes as sent. Re-serialising a
   * parsed object does not reproduce them — key order and whitespace differ —
   * so the signature has to be checked against what actually arrived.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch {
        done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined);
      }
    },
  );

  /**
   * Plain HTML forms post urlencoded: the Pay button, and the design picker.
   *
   * Pay carries no fields at all — what is owed comes from the database, never
   * from the request — but Fastify refuses a content type it has no parser
   * for, and a client pressing Pay must not meet a 415.
   *
   * Parsed with URLSearchParams rather than a body plugin: these forms carry a
   * handful of short fields, and the last value wins, so a repeated key cannot
   * smuggle an array into somewhere a string was expected.
   */
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body: string, done) => {
      const out: Record<string, string> = {};
      try {
        for (const [k, v] of new URLSearchParams(body)) out[k] = v;
      } catch {
        // A body that will not parse is an empty body, not a 500. Every route
        // reading one of these forms validates what it finds anyway.
      }
      done(null, out);
    },
  );

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    else req.log.warn({ err: err.message }, "request rejected");
    // Never hand an internal message to a caller.
    reply.status(status).send({
      error: status >= 500 ? "internal_error" : err.code || "bad_request",
      requestId: req.id,
    });
  });

  /*
   * Rate limits (9 October 2026), per visitor: Cloudflare's address for them,
   * since every request reaches us through Cloudflare and Caddy. Webhooks,
   * the Flow endpoint and health checks are left alone: Meta and Paystack
   * send in bursts, and a webhook refused is a message or a payment missed.
   * Tighter on what costs something per call: a Paystack checkout or lookup,
   * a code, a PDF render.
   */
  const TIGHT: [RegExp, number][] = [
    [/^\/i\/:token\/pay$/, 10],
    [/^\/settings\/:token\/bank\//, 10],
    [/^\/pro\/start$/, 10],
    [/\/(pdf|receipt)$/, 30],
  ];
  app.addHook("onRoute", (opts) => {
    const tight = TIGHT.find(([re]) => re.test(opts.url ?? ""));
    if (tight) {
      opts.config = { ...((opts.config as object | undefined) ?? {}), rateLimit: { max: tight[1], timeWindow: "1 minute" } };
    }
  });
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => String(req.headers["cf-connecting-ip"] ?? req.ip),
    allowList: (req) => /^\/(webhooks|health|ready|flows)(\/|$|\?)/.test(req.url),
  });

  app.register(healthRoutes);
  app.register(brandRoutes);
  app.register(whatsappRoutes, { prefix: "/webhooks/whatsapp" });
  // No prefix: /i/{token} is a link people paste into WhatsApp, and every
  // character of it is one more chance to mistype.
  app.register(publicRoutes);
  app.register(proRoutes);
  app.register(flowRoutes);
  // Also unprefixed: /designs/{token} is a link opened from a phone.
  app.register(templateRoutes);
  // Also unprefixed and opened from a phone: /signature/{token}.
  app.register(signatureRoutes);
  app.register(settingsPageRoutes);

  /*
   * Cloudflare's Email Obfuscation rewrites every address in our HTML to
   * "[email protected]" and decodes it with a script — which never runs in a
   * sandboxed preview, an in-app browser that blocks it, or a PDF render. On
   * 3 October 2026 the settings preview showed a business's email as
   * "[email protected]", linking to Cloudflare. Our pages show addresses on
   * purpose, so every HTML response opts out.
   */
  /*
   * Cloudflare Web Analytics on the invoice, settings and design pages (9 Oct
   * 2026): real visits, no cookies. The live address only, so the staging
   * copy's tests are not counted with real clients.
   */
  const beacon = /^https:\/\/payment\.balans\.ng\/?$/.test(env.PUBLIC_BASE_URL)
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "5840e6a6d5e44268bc33108ccf69b164"}'></script>`
    : "";

  app.addHook("onSend", async (_req, reply, payload) => {
    const type = String(reply.getHeader("content-type") ?? "");
    if (typeof payload !== "string" || !type.startsWith("text/html")) return payload;
    return payload
      .replace(/<body([^>]*)>/i, "<body$1><!--email_off-->")
      .replace(/<\/body>/i, `<!--/email_off-->${beacon}</body>`);
  });
  // Cards — invoices priced abroad, and Pro — are Paystack. Naira invoices
  // are paid straight to the sender's own bank and need no webhook.
  app.register(paystackRoutes, { prefix: "/webhooks/paystack" });

  return app;
}
