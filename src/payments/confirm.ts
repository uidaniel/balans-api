/**
 * Marking a payment received (PRD F10).
 *
 * This is the only code in the system that moves a document to paid, and it is
 * written to be boring. Four rules shape all of it:
 *
 *   1. A webhook is a claim, not a fact. Nothing is marked paid until Monnify's
 *      own API has been asked and has agreed — same reference, same amount,
 *      same currency. A signed webhook proves who sent it, not what happened.
 *   2. Nothing is believed about the amount. What the client owed was written
 *      at initialisation, and what arrived is compared against that. A payment
 *      that does not match becomes `needs_review` for a person, never paid.
 *   3. It is idempotent. Monnify retries, and it retries on anything it does
 *      not see acknowledged. The second delivery of a payment must change
 *      nothing at all.
 *   4. It never touches a document twice. The increment and the status change
 *      happen in one transaction with the row locked, so two deliveries racing
 *      cannot both add the same money.
 */

import type { FastifyBaseLogger } from "fastify";
import { db, tx } from "../db/pool.ts";
import { verifyTransaction, type VerifiedTransaction } from "./monnify.ts";
import { activateByReference, collect, deductionFor, stateOf } from "../billing/subscription.ts";
import { settleParts } from "../documents/parts.ts";

export type ConfirmOutcome =
  /** Already done. A retry, and the right answer is to do nothing. */
  | { kind: "already_confirmed"; reference: string }
  | { kind: "unknown_reference"; reference: string }
  /** Somebody paid for Pro rather than an invoice (F18). */
  | { kind: "pro_activated"; reference: string; userId: string; until: Date; paidKobo: number }
  /** Verified and applied. Everything needed to tell the user. */
  | {
      kind: "confirmed";
      reference: string;
      /** The payment row, so a receipt can be rendered from it (F11). */
      paymentId: string;
      userId: string;
      documentId: string;
      documentType: string;
      documentNumber: number | null;
      clientName: string;
      paidKobo: number;
      totalKobo: number;
      amountPaidKobo: number;
      fullyPaid: boolean;
      method: string | null;
    }
  /** Verified and wrong. Held for a person to look at (F10). */
  | { kind: "needs_review"; reference: string; why: string }
  /** Not paid, and not an error: abandoned checkouts are the common case. */
  | { kind: "not_paid"; reference: string; status: string }
  /** We could not ask. Monnify should retry, so this must not return 200. */
  | { kind: "unverifiable"; reference: string; why: string };

/** The states in which Monnify says money actually arrived. */
const PAID_STATES = new Set(["PAID", "OVERPAID"]);

/**
 * A payment that turned out to be for Pro, not for an invoice.
 *
 * Verified against Monnify first, exactly as an invoice payment is — this
 * runs on a signed webhook, but a signature says the message came from them,
 * not that the money arrived. Nothing here trusts the amount in the event.
 *
 * Returns null when the reference is not a subscription at all, so the caller
 * can go on to report it as unknown.
 */
async function confirmSubscription(
  reference: string,
  transactionReference: string,
  verify: typeof verifyTransaction,
  log: FastifyBaseLogger,
): Promise<ConfirmOutcome | null> {
  const { rows } = await db().query<{ id: string; price_kobo: string; status: string }>(
    `SELECT id, price_kobo, status FROM subscriptions WHERE payment_reference = $1`,
    [reference],
  );
  const sub = rows[0];
  if (!sub) return null;

  if (sub.status === "active") return { kind: "already_confirmed", reference };

  const checked = await verify(transactionReference);
  if (!checked.ok) {
    log.error({ reference, message: checked.message }, "could not verify a Pro payment");
    return { kind: "unverifiable", reference, why: checked.message };
  }

  const t = checked.transaction;
  if (!PAID_STATES.has(t.paymentStatus)) {
    log.info({ reference, status: t.paymentStatus }, "Pro payment not paid");
    return { kind: "not_paid", reference, status: t.paymentStatus };
  }

  /*
   * Underpayment does not buy a month.
   *
   * A transfer is typed by hand, so ₦400 instead of ₦4,000 is a real
   * outcome. Activating on it would give away eleven months of Pro, and
   * refusing quietly is better than that — the payment is recorded against
   * the subscription either way, so support can see what arrived.
   */
  const price = Number(sub.price_kobo);
  if (t.amountPaidKobo < price) {
    log.warn(
      { reference, paidKobo: t.amountPaidKobo, priceKobo: price },
      "Pro payment short; not activating",
    );
    return { kind: "not_paid", reference, status: "UNDERPAID" };
  }

  const activated = await activateByReference(
    reference,
    t.amountPaidKobo,
    t.transactionReference,
    log,
  );

  // Lost the race to a redelivery that got here first.
  if (!activated) return { kind: "already_confirmed", reference };

  return {
    kind: "pro_activated",
    reference,
    userId: activated.userId,
    until: activated.until,
    paidKobo: t.amountPaidKobo,
  };
}

/**
 * States where the attempt is over and no money came.
 *
 * PENDING is deliberately not here. A pending transaction is a client sitting
 * on the checkout page right now, and writing it off as failed would put a
 * wrong word next to a payment that is still perfectly likely to arrive.
 * PARTIALLY_PAID is not here either: money did arrive, it was just not enough,
 * and that is a review rather than a failure.
 */
const DEAD_STATES = new Set(["ABANDONED", "CANCELLED", "FAILED", "EXPIRED", "REVERSED"]);

export async function confirmPayment(
  input: { paymentReference: string; transactionReference: string },
  log: FastifyBaseLogger,
  verify = verifyTransaction,
): Promise<ConfirmOutcome> {
  const reference = input.paymentReference;

  const existing = await db().query<{
    id: string;
    document_id: string;
    status: string;
    client_total_kobo: number;
    invoice_amount_kobo: number | null;
    balans_fee_kobo: number;
  }>(
    `SELECT id, document_id, status, client_total_kobo, invoice_amount_kobo, balans_fee_kobo
       FROM payments WHERE reference = $1`,
    [reference],
  );

  const payment = existing.rows[0];

  /*
   * No invoice payment under this reference. It may still be ours.
   *
   * Somebody paying for Pro is not paying an invoice: there is no document,
   * no client and no split, so nothing is written to `payments` and the
   * reference lives on the subscription instead. Until this branch existed
   * those payments fell through to `unknown_reference` — the money arrived
   * and the subscription stayed pending.
   */
  if (!payment) {
    const activated = await confirmSubscription(reference, input.transactionReference, verify, log);
    if (activated) return activated;

    // A reference we never issued. Not an error on our side, and not
    // something to act on: somebody else's event, or a probe.
    return { kind: "unknown_reference", reference };
  }

  // Rule 3, checked before any work: a retry costs one query and stops here.
  if (payment.status === "success") return { kind: "already_confirmed", reference };

  /* Rule 1: ask Monnify. ---------------------------------------------------- */
  const verified = await verify(input.transactionReference);
  if (!verified.ok) {
    log.error({ reference, message: verified.message }, "could not verify transaction");
    return { kind: "unverifiable", reference, why: verified.message };
  }

  const t = verified.transaction;

  if (!PAID_STATES.has(t.paymentStatus)) {
    // An abandoned checkout is the ordinary case and not worth alarming
    // anybody about. F10: log failed and abandoned charges, notify nobody.
    log.info({ reference, status: t.paymentStatus }, "transaction not paid");
    // Only write the attempt off when it is actually over. A PARTIALLY_PAID
    // one is money that arrived short, which the amount check below would
    // catch anyway, so it is held rather than buried.
    if (DEAD_STATES.has(t.paymentStatus)) {
      await markFailed(payment.id, t);
    } else if (t.paymentStatus === "PARTIALLY_PAID") {
      await markNeedsReview(payment.id, t, `only ${t.amountPaidKobo} kobo of ${payment.client_total_kobo} arrived`);
      return { kind: "needs_review", reference, why: "partial payment" };
    }
    return { kind: "not_paid", reference, status: t.paymentStatus };
  }

  /* Rule 2: believe nothing about the amount. -------------------------------- */
  const problem = mismatch(t, reference, payment.client_total_kobo);
  if (problem) {
    log.error(
      { reference, why: problem, expectedKobo: payment.client_total_kobo, paidKobo: t.amountPaidKobo },
      "payment held for review",
    );
    await markNeedsReview(payment.id, t, problem);
    return { kind: "needs_review", reference, why: problem };
  }

  /* Rule 4: apply it once. --------------------------------------------------- */
  /*
   * What this settles against the invoice, which is not always what arrived.
   *
   * When fees are passed to the client they pay the invoice amount grossed
   * up by the processor's cut, so the freelancer still receives the whole of
   * it. The surcharge is a charge for moving money and settles nothing: an
   * invoice credited with it disagreed with its own payment plan about what
   * was still owed, and showed the smaller figure in the larger type.
   *
   * Falls back to what was charged, which is the same number on every
   * payment that did not pass fees on, and is what rows written before
   * migration 0020 were backfilled with.
   */
  const creditKobo = payment.invoice_amount_kobo ?? payment.client_total_kobo;

  const applied = await apply(payment.id, payment.document_id, t, creditKobo);
  if (!applied) return { kind: "already_confirmed", reference };

  // F18: take what the cap allows towards an open subscription. After the
  // money is applied, never before — a deduction from a payment that did not
  // land is a charge for nothing.
  let subscriptionKobo = 0;
  try {
    const sub = await stateOf(applied.userId);
    if (sub.owedKobo > 0 && sub.collectionMethod === "deduct_from_invoice") {
      const take = deductionFor(t.amountPaidKobo, payment.balans_fee_kobo, sub.owedKobo);
      if (take.takeKobo > 0) {
        await collect(applied.userId, payment.id, take.takeKobo, log);
        subscriptionKobo = take.takeKobo;
      }
    }
  } catch (err) {
    // The invoice is paid and the user has been credited. A subscription we
    // failed to collect is money we are owed, not money they lost.
    log.error({ err, userId: applied.userId }, "could not collect the subscription");
  }

  log.info(
    {
      reference,
      subscriptionKobo,
      documentId: payment.document_id,
      paidKobo: t.amountPaidKobo,
      balansFeeKobo: payment.balans_fee_kobo,
      settlementKobo: t.settlementAmountKobo,
      method: t.paymentMethod,
      fullyPaid: applied.fullyPaid,
    },
    "payment confirmed",
  );

  return {
    kind: "confirmed",
    reference,
    paymentId: payment.id,
    userId: applied.userId,
    documentId: payment.document_id,
    documentType: applied.documentType,
    documentNumber: applied.documentNumber,
    clientName: applied.clientName,
    paidKobo: t.amountPaidKobo,
    totalKobo: applied.totalKobo,
    amountPaidKobo: applied.amountPaidKobo,
    fullyPaid: applied.fullyPaid,
    method: t.paymentMethod,
  };
}

/** What would make this payment wrong, if anything. */
function mismatch(t: VerifiedTransaction, reference: string, expectedKobo: number): string | null {
  // The reference Monnify echoes must be the one we asked about. Anything else
  // means we are about to credit the wrong document.
  if (t.paymentReference !== reference) {
    return `reference mismatch: asked about ${reference}, got ${t.paymentReference}`;
  }
  if (t.currency !== "NGN") return `currency was ${t.currency}, not NGN`;
  // Under-payment is not payment. Over-payment is real money that arrived, so
  // it is applied and flagged rather than refused.
  if (t.amountPaidKobo < expectedKobo) {
    return `paid ${t.amountPaidKobo} kobo against ${expectedKobo} expected`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */

type Applied = {
  userId: string;
  documentType: string;
  documentNumber: number | null;
  clientName: string;
  totalKobo: number;
  amountPaidKobo: number;
  fullyPaid: boolean;
};

/**
 * Writes the payment and the document together, or neither.
 *
 * The payment row is updated with a `status <> 'success'` guard, so if a
 * concurrent delivery got there first this finds nothing to update and returns
 * null rather than adding the money twice. That guard is the whole of the
 * idempotency; the earlier check is only an optimisation.
 */
async function apply(
  paymentId: string,
  documentId: string,
  t: VerifiedTransaction,
  /** What this settles against the invoice; see the caller. */
  creditKobo: number,
): Promise<Applied | null> {
  return tx(async (c) => {
    const claimed = await c.query(
      `UPDATE payments
          SET status = 'success',
              paid_at = now(),
              provider_reference = COALESCE($5, provider_reference),
              channel = $2,
              provider_fee_kobo = COALESCE($3, provider_fee_kobo),
              raw_verify_json = $4
        WHERE id = $1 AND status <> 'success'`,
      [
        paymentId,
        t.paymentMethod,
        // What the processor actually took, if Monnify told us: the gap
        // between what was payable and what settles.
        t.settlementAmountKobo === null ? null : t.totalPayableKobo - t.settlementAmountKobo,
        JSON.stringify(t),
        t.transactionReference,
      ],
    );

    if (claimed.rowCount === 0) return null;

    // Lock the document before reading the running total, so two payments
    // landing together cannot both read the same "already paid" figure.
    const { rows } = await c.query<{
      user_id: string;
      type: string;
      number: number | null;
      total_kobo: number;
      amount_paid_kobo: number;
      client_name: string;
    }>(
      `SELECT d.user_id, d.type, d.number, d.total_kobo, d.amount_paid_kobo, cl.name AS client_name
         FROM documents d JOIN clients cl ON cl.id = d.client_id
        WHERE d.id = $1 FOR UPDATE OF d`,
      [documentId],
    );
    const doc = rows[0];
    if (!doc) throw new Error(`payment ${paymentId} points at a document that is gone`);

    // F7: settle whichever parts this payment covers, and open the next one.
    // Done inside the same transaction as the document update, so a document
    // can never be part_paid with no part marked.
    await settleParts(documentId, creditKobo).catch(() => undefined);

    // `documents_paid_within_total` will not hold more than the total, and an
    // overpayment is a refund question rather than a bigger invoice. The
    // payment row keeps what really arrived.
    const paid = Math.min(doc.amount_paid_kobo + creditKobo, doc.total_kobo);
    const fullyPaid = paid >= doc.total_kobo;

    await c.query(
      `UPDATE documents
          SET amount_paid_kobo = $2,
              status = $3,
              paid_at = CASE WHEN $4::boolean THEN COALESCE(paid_at, now()) ELSE paid_at END
        WHERE id = $1`,
      [documentId, paid, fullyPaid ? "paid" : "part_paid", fullyPaid],
    );

    return {
      userId: doc.user_id,
      documentType: doc.type,
      documentNumber: doc.number,
      clientName: doc.client_name,
      totalKobo: doc.total_kobo,
      amountPaidKobo: paid,
      fullyPaid,
    };
  });
}

async function markFailed(paymentId: string, t: VerifiedTransaction): Promise<void> {
  await db().query(
    `UPDATE payments SET status = 'failed', raw_verify_json = $2
      WHERE id = $1 AND status = 'initialised'`,
    [paymentId, JSON.stringify(t)],
  );
}

async function markNeedsReview(
  paymentId: string,
  t: VerifiedTransaction,
  why: string,
): Promise<void> {
  await db().query(
    `UPDATE payments SET status = 'needs_review', raw_verify_json = $2
      WHERE id = $1 AND status <> 'success'`,
    [paymentId, JSON.stringify({ ...t, heldBecause: why })],
  );
}
