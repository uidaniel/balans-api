/**
 * Paystack webhook (International PRD section 8).
 *
 * Built the same way as the Monnify one and for the same reason: the work
 * happens *before* the 200. A webhook that is acknowledged and then dropped on
 * a crash is a payment somebody's client made and the freelancer never heard
 * about, and no amount of logging fixes that afterwards. Paystack retries what
 * it does not see acknowledged, so doing the work first turns a crash into a
 * retry.
 *
 * Three rules, and none of them is new — they are the ones `confirmPayment`
 * already enforces for Monnify, reached through the provider adapter so that
 * there is one answer to "is this really paid?" rather than two:
 *
 *   1. A signed body proves who sent it, not what happened. Nothing is marked
 *      paid until Paystack's own verify endpoint says so.
 *   2. Nothing about the amount in the event is believed. What was owed was
 *      written at initialisation and what arrived is compared against it.
 *   3. It is idempotent by reference, because Paystack redelivers.
 *
 * Section 10's chargeback handling is here too, and it is deliberately blunt:
 * v1 is manual. A dispute marks the payment, alerts an admin, and stops that
 * user invoicing abroad until somebody has looked. Automating recovery on a
 * payment method Balans has never taken would be automating a guess.
 */

import type { FastifyInstance } from "fastify";

import { db } from "../../db/pool.ts";
import { confirmPayment } from "../../payments/confirm.ts";
import { emailProActive, notifyPaid, notifyProActive } from "../../payments/notify.ts";
import { reversePayment } from "../../payments/refund.ts";
import { paystackConfigured, verifySignature, verifyTransaction } from "../../payments/paystack.ts";
import { verifyWithPaystack } from "../../payments/provider.ts";

/** The part of the payload we act on. All of it is stored regardless. */
type Event = {
  event?: string;
  data?: {
    id?: number;
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
  };
};

/** A card was charged. The only event that can mark a document paid. */
const PAID = "charge.success";

/**
 * Money going back out, or being argued about.
 *
 * `charge.dispute.create` is a client telling their bank they did not
 * authorise the payment; `refund.processed` is money actually returned. They
 * are different things and both mean the invoice is no longer settled, which
 * is the only fact this route needs from either.
 */
const DISPUTES = new Set(["charge.dispute.create", "charge.dispute.remind"]);
const REFUNDS = new Set(["refund.processed", "refund.processing"]);

async function markProcessed(eventId: string, outcome: string | null): Promise<void> {
  await db()
    .query(
      `UPDATE webhook_events SET processed_at = now(), error = $2
        WHERE provider = 'paystack' AND event_id = $1`,
      [eventId, outcome],
    )
    .catch(() => {});
}

/**
 * Where the card was issued, recorded on the payment (section 8).
 *
 * Best effort and never allowed to fail the request: the money is already
 * applied by the time this runs, and losing a country code must not make
 * Paystack redeliver a payment that is settled. A Nigerian card paying an
 * international invoice is still a valid payment — this is only how we can
 * see afterwards that that is what happened, and the fee and the chargeback
 * risk are not the same for the two.
 */
async function recordCard(reference: string, log: FastifyInstance["log"]): Promise<void> {
  try {
    const res = await verifyTransaction(reference);
    if (!res.ok) return;
    await db().query(
      `UPDATE payments
          SET card_country = $2, is_international_card = $3
        WHERE reference = $1`,
      [reference, res.transaction.cardCountry, res.transaction.internationalCard],
    );
  } catch (err) {
    log.warn({ err, reference }, "could not record the card's origin");
  }
}

export async function paystackRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (req, reply) => {
    /*
     * No key, no webhook. Without one the signature cannot be checked, and a
     * route that accepted unsigned bodies because it was misconfigured would
     * be a route anybody could mark invoices paid through.
     */
    if (!paystackConfigured()) {
      req.log.error("paystack webhook received but no key is configured");
      return reply.status(503).send({ error: "not_configured" });
    }

    const valid = verifySignature(
      req.rawBody ?? Buffer.alloc(0),
      req.headers["x-paystack-signature"] as string | undefined,
    );

    if (!valid) {
      // Section 11: reject anything unsigned, and say nothing about why.
      req.log.warn("paystack webhook failed signature check");
      return reply.status(401).send({ error: "bad_signature" });
    }

    const event = req.body as Event;
    const data = event.data ?? {};
    const reference = data.reference;
    const type = event.event ?? "";

    /*
     * Stored raw before anything is decided, so a payload we mishandle is
     * still on disk to be reprocessed. Paystack sends an `id` per
     * transaction, not per delivery, so the event id is the type and the
     * reference together — one row per thing that happened, which is the
     * grain the unique index wants and which makes a redelivery a no-op here
     * as well as in `confirmPayment`.
     */
    const eventId = `${type || "unknown"}:${reference ?? data.id ?? "none"}`;
    await db()
      .query(
        `INSERT INTO webhook_events (provider, event_id, event_type, payload_json, signature_valid)
         VALUES ('paystack', $1, $2, $3, TRUE)
         ON CONFLICT (provider, event_id) DO NOTHING`,
        [eventId, type || null, req.body],
      )
      .catch((err: unknown) => {
        // Losing the audit copy must not lose the payment. Carry on and shout.
        req.log.error({ err, eventId }, "could not store webhook event");
      });

    /* Money going back out, or being disputed. ------------------------------ */
    if (DISPUTES.has(type) || REFUNDS.has(type)) {
      if (!reference) {
        req.log.warn({ eventId }, "reversal event with no reference");
        return reply.send({ ok: true });
      }

      const outcome = await reversePayment(
        {
          providerReference: reference,
          amountKobo: typeof data.amount === "number" ? data.amount : null,
          to: DISPUTES.has(type) ? "disputed" : "refunded",
          raw: req.body,
        },
        req.log,
      );

      /*
       * Loudly, and by hand from here (section 10). A card payment can be
       * reversed weeks after it settled, and the money comes out of the
       * freelancer's own account — so this is the one event on this route
       * that a person has to see the same day.
       */
      req.log.error(
        { eventType: type, reference, outcome: outcome.kind },
        "PAYSTACK DISPUTE OR REFUND — needs a person",
      );
      await markProcessed(eventId, outcome.kind === "reversed" ? null : outcome.kind);
      return reply.send({ ok: true });
    }

    if (type !== PAID) {
      req.log.info({ eventType: type }, "paystack event ignored");
      await markProcessed(eventId, null);
      return reply.send({ ok: true });
    }

    if (!reference) {
      req.log.warn({ eventId }, "payment event with no reference");
      return reply.send({ ok: true });
    }

    /*
     * Both references are ours: Paystack verifies by the one we set and has
     * no second identifier to quote back. See `verifyWithPaystack`.
     */
    const outcome = await confirmPayment(
      { paymentReference: reference, transactionReference: reference },
      req.log,
      verifyWithPaystack,
    );

    await markProcessed(eventId, outcome.kind === "confirmed" ? null : outcome.kind);

    switch (outcome.kind) {
      case "confirmed":
        // Not awaited: the money is recorded, and a WhatsApp outage must not
        // make Paystack retry a payment that is already applied.
        // With the provider on it, so the message does not promise Monnify's
        // "tonight" about a card on somebody else's settlement schedule.
        void notifyPaid({ ...outcome, provider: "paystack" }, req.log);
        void recordCard(reference, req.log);
        return reply.send({ ok: true });

      case "pro_activated":
        // Nothing routes Pro through Paystack today — subscriptions are naira
        // — but `confirmPayment` can reach this branch and silently doing
        // nothing with it would be a subscription somebody paid for and was
        // never told about.
        void notifyProActive(outcome.userId, outcome.until, req.log);
        void emailProActive(outcome.userId, outcome.until, outcome.paidKobo, req.log);
        return reply.send({ ok: true });

      case "unverifiable":
        // We could not ask Paystack what happened, so we do not know. A 500
        // asks for a retry, which is the only honest answer.
        req.log.error({ reference: outcome.reference }, "asking for a retry");
        return reply.status(500).send({ error: "verification_failed" });

      default:
        // Already done, not ours, not paid, or held for review. All of these
        // are settled as far as Paystack is concerned.
        return reply.send({ ok: true });
    }
  });
}
