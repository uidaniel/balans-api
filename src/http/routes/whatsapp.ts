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
import { parseInbound, type Inbound } from "../../whatsapp/inbound.ts";
import { handleInbound } from "../../conversation/handle.ts";

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

    /*
     * The test number's traffic belongs to the staging server (9 October
     * 2026): passed on as it came, signature and all, so staging checks it
     * exactly as this server would, and nothing here touches it.
     */
    const staging = env.WA_STAGING_PHONE_NUMBER_ID;
    if (staging && env.STAGING_WEBHOOK_URL) {
      const numbers = (body.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.value?.metadata?.phone_number_id));
      if (numbers.length && numbers.every((n) => n === staging)) {
        const forwarded = await fetch(env.STAGING_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": String(req.headers["x-hub-signature-256"] ?? ""),
          },
          body: raw,
          signal: AbortSignal.timeout(8_000),
        }).catch((err: unknown) => {
          req.log.warn({ err }, "could not hand the test number's webhook to staging");
          return null;
        });
        req.log.info({ status: forwarded?.status ?? null }, "test number webhook handed to staging");
        return reply.status(200).send({ received: true, staging: true });
      }
    }

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

    // Acknowledge first, then do the work.
    //
    // Meta retries anything it does not see acknowledged quickly, and a slow
    // handler turns one message into several. Replying to the person takes a
    // round trip to the Graph API, which is far too long to hold this open.
    //
    // The work happens here, detached, and is tracked: a shutdown waits for
    // it (`drainInbound`), and anything a restart still cut off is picked up
    // again at boot (`replayUnanswered`). Every deploy restarts this process,
    // and a message that landed in that minute used to get no reply at all.
    const { messages } = parseInbound(body);
    for (const m of messages) track(m, req.log);

    req.log.info({ events: events.length, messages: messages.length }, "webhook accepted");
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

/* -------------------------------------------------------------------------- */
/* Surviving a restart                                                        */
/* -------------------------------------------------------------------------- */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

const inflight = new Set<Promise<void>>();

/** Handles one message, remembering it is in progress and marking it done. */
function track(m: Inbound, log: Log): void {
  const job: Promise<void> = handleInbound(m, log as never)
    .catch((err: unknown) => log.error({ err, waMessageId: m.waMessageId }, "failed to handle message"))
    .then(() =>
      db()
        .query(`UPDATE webhook_events SET processed_at = now() WHERE provider = 'whatsapp' AND event_id = $1`, [
          m.waMessageId,
        ])
        .then(() => undefined)
        .catch(() => undefined),
    )
    .finally(() => inflight.delete(job));
  inflight.add(job);
}

/**
 * On shutdown: let the replies already under way finish, up to `ms`.
 *
 * A deploy stops this process with a few seconds' grace. A reply takes one
 * to three — a card to draw, a call to Meta — so most finish inside it.
 */
export async function drainInbound(ms: number): Promise<number> {
  const waiting = inflight.size;
  if (waiting === 0) return 0;
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, ms))]);
  return waiting;
}

/**
 * At boot: answer what a restart cut off.
 *
 * A message is picked up again only if all of these hold, so nobody is ever
 * answered twice:
 *   - it arrived in the last ten minutes (older, and a reply is just noise);
 *   - its handling never finished (`processed_at` is still empty);
 *   - nothing has been sent to that person since it arrived.
 *
 * It is handled as a replay, because its id is already stored and would
 * otherwise be taken for a redelivery and ignored.
 */
export async function replayUnanswered(log: Log): Promise<number> {
  const { rows } = await db().query<{ event_id: string; payload_json: { change?: { value?: Record<string, unknown> }; message?: unknown } }>(
    `SELECT e.event_id, e.payload_json
       FROM webhook_events e
       JOIN messages i ON i.wa_message_id = e.event_id AND i.direction = 'in'
      WHERE e.provider = 'whatsapp'
        AND e.event_type LIKE 'message.%'
        AND e.processed_at IS NULL
        AND e.received_at > now() - interval '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM messages o
           WHERE o.user_id = i.user_id AND o.direction = 'out' AND o.created_at > i.created_at
        )
      ORDER BY e.received_at`,
  );

  let replayed = 0;
  for (const r of rows) {
    const change = r.payload_json?.change;
    if (!change?.value || !r.payload_json?.message) continue;
    // Back into the envelope Meta sent, with only this one message in it.
    const { messages } = parseInbound({
      entry: [{ changes: [{ ...change, value: { ...change.value, messages: [r.payload_json.message], statuses: [] } }] }],
    });
    const m = messages.find((x) => x.waMessageId === r.event_id);
    if (!m) continue;
    log.warn({ waMessageId: m.waMessageId }, "answering a message a restart cut off");
    track({ ...m, replay: true }, log);
    replayed += 1;
  }
  return replayed;
}
