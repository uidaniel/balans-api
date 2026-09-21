/**
 * WhatsApp Cloud API webhook (PRD F1, section 8).
 *
 * Two jobs, and deliberately nothing else:
 *   GET   Meta's one-time subscription handshake.
 *   POST  Verify the signature, record the event, acknowledge.
 *
 * The POST does no product work. Meta retries anything it does not see
 * acknowledged quickly, and a slow handler turns one message into several. So
 * the row is written and 200 returned; the worker picks it up from there.
 */

import type { FastifyInstance } from "fastify";
import { env, require_ } from "../../config.ts";
import { db } from "../../db/pool.ts";
import { safeEqual, verifyMetaSignature } from "../../lib/crypto.ts";

type VerifyQuery = {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
};

/** The shape we rely on. Meta sends a great deal more, and it is all kept. */
type Change = {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { phone_number_id?: string };
    messages?: { id?: string; from?: string; type?: string; timestamp?: string }[];
    statuses?: { id?: string; status?: string }[];
  };
};
type Payload = { object?: string; entry?: { id?: string; changes?: Change[] }[] };

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Subscription handshake. Meta calls this once when the webhook is saved and
   * expects the challenge echoed back as plain text.
   */
  app.get<{ Querystring: VerifyQuery }>("/", async (req, reply) => {
    require_("WA_VERIFY_TOKEN");
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode !== "subscribe" || !token || !safeEqual(token, env.WA_VERIFY_TOKEN!)) {
      req.log.warn({ mode }, "webhook verification rejected");
      return reply.status(403).send("forbidden");
    }

    req.log.info("webhook verified");
    return reply.type("text/plain").send(challenge ?? "");
  });

  app.post("/", async (req, reply) => {
    require_("WA_APP_SECRET");

    const raw = req.rawBody ?? Buffer.alloc(0);
    const valid = verifyMetaSignature(
      raw,
      req.headers["x-hub-signature-256"] as string | undefined,
      env.WA_APP_SECRET!,
    );

    // Section 11: reject unsigned requests. Answer 403 without a hint as to
    // which part failed.
    if (!valid) {
      req.log.warn("inbound webhook failed signature check");
      return reply.status(403).send({ error: "bad_signature" });
    }

    const body = req.body as Payload;
    const events = extractEvents(body);

    // Meta batches, and redelivers on any doubt. Each message id is written
    // once; a repeat collides on the unique index and is skipped, which is what
    // makes redelivery harmless rather than a duplicate invoice.
    for (const e of events) {
      try {
        await db().query(
          `INSERT INTO webhook_events (provider, event_id, event_type, payload_json, signature_valid)
           VALUES ('whatsapp', $1, $2, $3, TRUE)
           ON CONFLICT (provider, event_id) DO NOTHING`,
          [e.id, e.type, e.payload],
        );
      } catch (err) {
        // A storage failure must not make Meta retry forever: log it loudly and
        // still acknowledge. Reconciliation catches anything lost (F27).
        req.log.error({ err, eventId: e.id }, "could not record webhook event");
      }
    }

    req.log.info({ events: events.length }, "webhook accepted");
    return reply.status(200).send({ received: true });
  });
}

/**
 * Flattens Meta's entry/changes envelope into one row per message or status.
 *
 * The id is what makes processing idempotent, so anything without one is given
 * a deterministic fallback rather than a random id: a random one would defeat
 * the unique index the moment Meta redelivered.
 */
function extractEvents(body: Payload): { id: string; type: string; payload: unknown }[] {
  const out: { id: string; type: string; payload: unknown }[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;

      for (const m of v.messages ?? []) {
        if (m.id) out.push({ id: m.id, type: `message.${m.type ?? "unknown"}`, payload: { change, message: m } });
      }
      for (const s of v.statuses ?? []) {
        if (s.id) out.push({ id: `${s.id}:${s.status}`, type: `status.${s.status}`, payload: { change, status: s } });
      }
    }
  }

  if (out.length === 0 && body.entry?.length) {
    const id = body.entry[0]?.id;
    if (id) out.push({ id: `entry:${id}:${hash(body)}`, type: "unknown", payload: body });
  }
  return out;
}

/** Stable digest of a payload, so an unrecognised event still dedupes. */
function hash(v: unknown): string {
  let h = 0;
  const s = JSON.stringify(v);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
