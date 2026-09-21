/**
 * Monnify webhook (PRD F10, section 8).
 *
 * This route differs from the WhatsApp one on purpose. That one records the
 * event, answers 200 immediately and lets a worker do the thinking, because a
 * slow acknowledgement turns one message into several.
 *
 * Here the work happens before the 200. A webhook that is acknowledged and
 * then dropped on a crash is a payment the client made and the user never
 * heard about, and no amount of logging fixes that afterwards. Monnify retries
 * anything it does not see acknowledged, so answering only once the money is
 * recorded turns a crash into a retry. The work is one verify call and two
 * updates; it is fast enough to do honestly.
 */

import type { FastifyInstance } from "fastify";
import { env, require_ } from "../../config.ts";
import { db } from "../../db/pool.ts";
import { verifyMonnifySignature } from "../../lib/crypto.ts";
import { confirmPayment } from "../../payments/confirm.ts";
import { notifyPaid } from "../../payments/notify.ts";
import { reversePayment } from "../../payments/refund.ts";

/** The part of Monnify's payload we act on. All of it is stored regardless. */
type Event = {
  eventType?: string;
  eventData?: {
    paymentReference?: string;
    transactionReference?: string;
    paymentStatus?: string;
    amountPaid?: unknown;
    /** Refunds quote Monnify's reference and their own amount. */
    refundReference?: string;
    refundAmount?: unknown;
    refundStatus?: string;
  };
};

/** A customer paid. The only event that can mark a document paid. */
const PAYMENT_EVENTS = new Set(["SUCCESSFUL_TRANSACTION"]);

/**
 * Money going back out.
 *
 * The exact strings are Monnify's, and they are worth being generous about:
 * a refund we fail to recognise leaves an invoice showing paid when the client
 * has their money back, which is worse than reversing something twice (which
 * is guarded anyway).
 */
const REFUND_EVENTS = new Set(["REFUND_COMPLETED", "SUCCESSFUL_REFUND", "REFUND_SUCCESSFUL"]);
const DISPUTE_EVENTS = new Set(["CHARGEBACK", "CHARGEBACK_CREATED", "DISPUTE_CREATED"]);

/** Kobo from Monnify's decimal naira, wherever it appears. */
function toKobo(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Marks the stored event handled, and why, without ever failing the request. */
async function markProcessed(eventId: string, outcome: string | null): Promise<void> {
  await db()
    .query(
      `UPDATE webhook_events SET processed_at = now(), error = $2
        WHERE provider = 'monnify' AND event_id = $1`,
      [eventId, outcome],
    )
    .catch(() => {});
}

export async function monnifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (req, reply) => {
    require_("MONNIFY_SECRET_KEY");

    const valid = verifyMonnifySignature(
      req.rawBody ?? Buffer.alloc(0),
      req.headers["monnify-signature"] as string | undefined,
      env.MONNIFY_SECRET_KEY!,
    );

    if (!valid) {
      // Section 11: reject anything unsigned, and say nothing about why.
      req.log.warn("monnify webhook failed signature check");
      return reply.status(401).send({ error: "bad_signature" });
    }

    const event = req.body as Event;
    const data = event.eventData ?? {};
    const paymentReference = data.paymentReference;
    const transactionReference = data.transactionReference;

    // Stored raw before anything is decided, so a payload we mishandle is
    // still on disk to be reprocessed. The reference is the event id: Monnify
    // does not send one, and one event per reference per type is exactly the
    // grain we want the unique index at.
    const eventId = `${event.eventType ?? "unknown"}:${transactionReference ?? paymentReference ?? "none"}`;
    await db()
      .query(
        `INSERT INTO webhook_events (provider, event_id, event_type, payload_json, signature_valid)
         VALUES ('monnify', $1, $2, $3, TRUE)
         ON CONFLICT (provider, event_id) DO NOTHING`,
        [eventId, event.eventType ?? null, req.body],
      )
      .catch((err: unknown) => {
        // Losing the audit copy must not lose the payment. Carry on and shout.
        req.log.error({ err, eventId }, "could not store webhook event");
      });

    const type = event.eventType ?? "";

    /* Money going back out. ------------------------------------------------- */
    if (REFUND_EVENTS.has(type) || DISPUTE_EVENTS.has(type)) {
      if (!transactionReference) {
        req.log.warn({ eventId }, "reversal event with no transaction reference");
        return reply.send({ ok: true });
      }
      const outcome = await reversePayment(
        {
          providerReference: transactionReference,
          amountKobo: toKobo(data.refundAmount ?? data.amountPaid),
          to: DISPUTE_EVENTS.has(type) ? "disputed" : "refunded",
          raw: req.body,
        },
        req.log,
      );
      req.log.info({ eventType: type, outcome: outcome.kind }, "reversal handled");
      await markProcessed(eventId, outcome.kind === "reversed" ? null : outcome.kind);
      return reply.send({ ok: true });
    }

    /* Settlement: the money actually reaching the user's bank. -------------- */
    if (type.includes("SETTLEMENT")) {
      // Nothing to change — the document was settled when the payment landed.
      // It is recorded because it is the only evidence that the split paid the
      // user rather than us, which is the claim the whole product rests on.
      req.log.info({ eventId, payload: event.eventData }, "settlement reported");
      await markProcessed(eventId, null);
      return reply.send({ ok: true });
    }

    if (!PAYMENT_EVENTS.has(type)) {
      req.log.info({ eventType: event.eventType }, "monnify event ignored");
      return reply.send({ ok: true });
    }

    if (!paymentReference || !transactionReference) {
      req.log.warn({ eventId }, "payment event with no reference");
      return reply.send({ ok: true });
    }

    const outcome = await confirmPayment(
      { paymentReference, transactionReference },
      req.log,
    );

    await markProcessed(eventId, outcome.kind === "confirmed" ? null : outcome.kind);

    switch (outcome.kind) {
      case "confirmed":
        // Not awaited: the money is recorded, and a WhatsApp outage must not
        // make Monnify retry a payment that is already applied.
        void notifyPaid(outcome, req.log);
        return reply.send({ ok: true });

      case "unverifiable":
        // We could not ask Monnify what happened, so we do not know. A 500
        // asks them to try again, which is the only honest answer.
        req.log.error({ reference: outcome.reference }, "asking for a retry");
        return reply.status(500).send({ error: "verification_failed" });

      default:
        // Already done, not ours, not paid, or held for review. All of these
        // are settled as far as Monnify is concerned.
        return reply.send({ ok: true });
    }
  });
}
