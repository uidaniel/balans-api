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
  /**
   * What this settles against the invoice.
   *
   * The same as `amountKobo` until fees are passed to the client. When they
   * are, the client is charged the invoice amount grossed up by the
   * processor's cut, and the difference is a surcharge for moving money
   * rather than part of what was billed. Crediting the invoice with the
   * surcharge left an invoice disagreeing with its own payment plan about
   * what was still owed — see migration 0020.
   */
  invoiceAmountKobo: number;
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
        invoice_amount_kobo, provider_fee_kobo, balans_fee_kobo, fee_bearer, status,
        raw_verify_json)
     VALUES ($1, $2, $3, $4, $5, $9, $6, $7, 'user', 'initialised', $8)
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
      p.invoiceAmountKobo,
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

/* -------------------------------------------------------------------------- */
/* Pay by transfer                                                            */
/* -------------------------------------------------------------------------- */

export type LiveTransfer = {
  reference: string;
  providerReference: string;
  amountKobo: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
  ussd: string | null;
  expiresAt: Date;
};

/** Keeps the account Monnify issued, against the payment it belongs to. */
export async function recordTransferAccount(
  reference: string,
  a: {
    bankName: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    ussd: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await db().query(
    `UPDATE payments
        SET transfer_bank_name = $2, transfer_bank_code = $3,
            transfer_account_number = $4, transfer_account_name = $5,
            transfer_ussd = $6, transfer_expires_at = $7
      WHERE reference = $1`,
    [reference, a.bankName, a.bankCode, a.accountNumber, a.accountName, a.ussd, a.expiresAt],
  );
}

/**
 * The account a client is already part-way through paying into, if there is one.
 *
 * Bounded by the expiry Monnify gave and by the amount still being asked for.
 * Reusing an account is the point: somebody who has copied the number into
 * their banking app and come back must not be shown a different one, or the
 * transfer they are about to send lands against nothing.
 *
 * A minute of headroom, because the client still has to finish in their bank's
 * app after they read this. An account with forty seconds left is worse than
 * no account at all.
 */
export async function liveTransferFor(
  documentId: string,
  amountKobo: number,
): Promise<LiveTransfer | null> {
  const { rows } = await db().query<{
    reference: string;
    provider_reference: string;
    client_total_kobo: string;
    transfer_bank_name: string;
    transfer_account_number: string;
    transfer_account_name: string;
    transfer_ussd: string | null;
    transfer_expires_at: Date;
  }>(
    `SELECT reference, provider_reference, client_total_kobo,
            transfer_bank_name, transfer_account_number, transfer_account_name,
            transfer_ussd, transfer_expires_at
       FROM payments
      WHERE document_id = $1
        AND status = 'initialised'
        AND transfer_account_number IS NOT NULL
        AND transfer_expires_at > now() + interval '1 minute'
        AND client_total_kobo = $2
      ORDER BY transfer_expires_at DESC
      LIMIT 1`,
    [documentId, amountKobo],
  );

  const r = rows[0];
  return r
    ? {
        reference: r.reference,
        providerReference: r.provider_reference,
        amountKobo: Number(r.client_total_kobo),
        bankName: r.transfer_bank_name,
        accountNumber: r.transfer_account_number,
        accountName: r.transfer_account_name,
        ussd: r.transfer_ussd,
        expiresAt: r.transfer_expires_at,
      }
    : null;
}

/** What the page's poll asks: has this document been settled yet? */
export async function paymentProgress(
  documentId: string,
): Promise<{ paid: boolean; pending: { reference: string; providerReference: string }[] }> {
  const { rows } = await db().query<{
    status: string;
    reference: string;
    provider_reference: string;
  }>(
    `SELECT status, reference, provider_reference
       FROM payments WHERE document_id = $1`,
    [documentId],
  );

  return {
    paid: rows.some((r) => r.status === "success"),
    pending: rows
      .filter((r) => r.status === "initialised")
      .map((r) => ({ reference: r.reference, providerReference: r.provider_reference })),
  };
}
