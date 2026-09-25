/**
 * HTTP surface. Stateless: anything that outlives a request belongs in Postgres
 * or the job queue (PRD section 3).
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { env, isProd } from "../config.ts";
import { healthRoutes } from "./routes/health.ts";
import { brandRoutes } from "./routes/brand.ts";
import { whatsappRoutes } from "./routes/whatsapp.ts";
import { publicRoutes } from "./routes/public.ts";
import { proRoutes } from "./routes/pro.ts";
import { monnifyRoutes } from "./routes/monnify.ts";
import { paystackRoutes } from "./routes/paystack.ts";
import { templateRoutes } from "./routes/templates.ts";
import { signatureRoutes } from "./routes/signature.ts";

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
  'req.headers["monnify-signature"]',
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

  app.register(healthRoutes);
  app.register(brandRoutes);
  app.register(whatsappRoutes, { prefix: "/webhooks/whatsapp" });
  // No prefix: /i/{token} is a link people paste into WhatsApp, and every
  // character of it is one more chance to mistype.
  app.register(publicRoutes);
  app.register(proRoutes);
  // Also unprefixed: /designs/{token} is a link opened from a phone.
  app.register(templateRoutes);
  // Also unprefixed and opened from a phone: /signature/{token}.
  app.register(signatureRoutes);
  app.register(monnifyRoutes, { prefix: "/webhooks/monnify" });
  // Naira goes to Monnify above; invoices priced abroad are cards, and cards
  // are Paystack. Two processors, one confirmation path — see
  // `payments/provider.ts`.
  app.register(paystackRoutes, { prefix: "/webhooks/paystack" });

  return app;
}
