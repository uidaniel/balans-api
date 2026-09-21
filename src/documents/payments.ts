/**
 * Payment records (PRD F10, section 7).
 *
 * A row is written the moment a payment is *started*, before the client has
 * typed a card number. That row is what the webhook looks the payment up by,
 * and writing it first is what makes the flow idempotent: `payments.reference`
 * is unique, so a duplicated webhook has an existing row to find rather than a
 * second one to create.
 *
 * Nothing here marks anything paid. That happens once, on a webhook that has
 * been verified against the provider's own API, and it lives with the webhook.
 */

import { db } from "../db/pool.ts";

export type InitialisedPayment = {
  documentId: string;
  userId: string;
  /** Ours, and the idempotency key. */
  reference: string;
  /** The provider's, for reconciliation. */
  providerReference: string;
  /** What the client is being charged. */
  amountKobo: number;
  balansFeeKobo: number;
  /**
   * What we expect the processor to take, from our own rate table.
   *
   * Kept so reconciliation can compare it against what the provider actually
   * charged. A drift here is how we find out their schedule changed, or that
   * ours was wrong — which matters, because these rates were written for a
   * different processor.
   */
  expectedProcessorFeeKobo: number;
};

export async function recordInitialisedPayment(p: InitialisedPayment): Promise<void> {
  await db().query(
    `INSERT INTO payments
       (document_id, reference, provider_reference, amount_kobo, client_total_kobo,
        provider_fee_kobo, balans_fee_kobo, fee_bearer, status, raw_verify_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', 'initialised', $8)
     ON CONFLICT (reference) DO NOTHING`,
    [
      p.documentId,
      p.reference,
      // Monnify's own reference. A refund or a chargeback quotes this rather
      // than ours, because those are events about the transaction.
      p.providerReference,
      // What the user is owed out of this payment, before the processor's cut.
      p.amountKobo - p.balansFeeKobo,
      p.amountKobo,
      p.expectedProcessorFeeKobo,
      p.balansFeeKobo,
      JSON.stringify({ providerReference: p.providerReference, stage: "initialised" }),
    ],
  );
}

/** Every payment attempt on a document, newest first, for the status page. */
export async function paymentsFor(documentId: string): Promise<
  { reference: string; status: string; amountKobo: number; paidAt: Date | null }[]
> {
  const { rows } = await db().query<{
    reference: string;
    status: string;
    client_total_kobo: number;
    paid_at: Date | null;
  }>(
    `SELECT reference, status, client_total_kobo, paid_at
       FROM payments WHERE document_id = $1 ORDER BY created_at DESC`,
    [documentId],
  );
  return rows.map((r) => ({
    reference: r.reference,
    status: r.status,
    amountKobo: r.client_total_kobo,
    paidAt: r.paid_at,
  }));
}
