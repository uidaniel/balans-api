/**
 * HTTP surface. Stateless: anything that outlives a request belongs in Postgres
 * or the job queue (PRD section 3).
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { env, isProd } from "../config.ts";
import { healthRoutes } from "./routes/health.ts";
import { whatsappRoutes } from "./routes/whatsapp.ts";

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
  app.register(whatsappRoutes, { prefix: "/webhooks/whatsapp" });

  return app;
}
