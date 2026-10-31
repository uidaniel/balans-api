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
   * ours was wrong.
   */
  expectedProcessorFeeKobo: number;
  /**
   * Where the client goes to type their card, for a card payment.
   *
   * Kept so that pressing Pay again lands on the transaction that is already
   * open instead of starting a second one. See `liveCardCheckoutFor`.
   */
  checkoutUrl?: string;
};

export async function recordInitialisedPayment(p: InitialisedPayment): Promise<void> {
  await db().query(
    `INSERT INTO payments
       (document_id, reference, provider_reference, amount_kobo, client_total_kobo,
        invoice_amount_kobo, provider_fee_kobo, balans_fee_kobo, fee_bearer, status,
        raw_verify_json, provider)
     VALUES ($1, $2, $3, $4, $5, $9, $6, $7, 'user', 'initialised', $8, 'paystack')
     ON CONFLICT (reference) DO NOTHING`,
    [
      p.documentId,
      p.reference,
      // The processor's own reference. A refund or a chargeback quotes this
      // rather than ours, because those are events about the transaction.
      p.providerReference,
      // What the user is owed out of this payment, before the processor's cut.
      p.amountKobo - p.balansFeeKobo,
      p.amountKobo,
      p.expectedProcessorFeeKobo,
      p.balansFeeKobo,
      JSON.stringify({
        providerReference: p.providerReference,
        stage: "initialised",
        ...(p.checkoutUrl ? { checkoutUrl: p.checkoutUrl } : {}),
      }),
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

/**
 * Payments started but not yet known to have landed.
 *
 * The page's poll walks these and asks the processor about each, which is how
 * a payment still shows up when the webhook is late.
 *
 * This replaced a version that also reported whether the document had *ever*
 * had a successful payment, which the poll took as "something has happened,
 * reload". On a part-paid invoice that is true for ever: the page reloaded,
 * asked again, was told the same thing, and reloaded again — a refresh loop
 * for as long as anybody left the invoice open. The same flag made the poll
 * skip this list entirely once a deposit had landed, so the balance could
 * never be confirmed from the page at all.
 *
 * What changed is where the question is asked. Whether anything has moved is
 * not a property of the document; it is a comparison against what the page
 * was drawn with, and only the page knows that.
 */
export async function pendingPaymentsFor(
  documentId: string,
): Promise<{ reference: string; providerReference: string }[]> {
  /*
   * Paystack's only, and the filter is not optional.
   *
   * Confirming a payment means asking the processor that took it, and
   * Paystack is the only one there is. A row from any earlier processor is
   * a reference Paystack has never heard of: asked about, it answers "not
   * found" for ever and the page polls it on every visit. Those rows are
   * left out rather than asked about.
   */
  const { rows } = await db().query<{
    reference: string;
    provider_reference: string;
  }>(
    `SELECT reference, provider_reference
       FROM payments
      WHERE document_id = $1 AND status = 'initialised' AND provider = 'paystack'`,
    [documentId],
  );
  return rows.map((r) => ({
    reference: r.reference,
    providerReference: r.provider_reference,
  }));
}

/**
 * How long a checkout that is already open is offered again instead of a new
 * one.
 *
 * Long enough to cover the two ways somebody presses Pay twice — a browser
 * submitting the form twice in the same second, and a person who opened
 * checkout, thought better of it and came back a minute later. Short enough
 * that a link Paystack has since timed out is not handed to somebody as
 * though it were live.
 */
const CHECKOUT_REUSE_MINUTES = 10;

/**
 * The card checkout already open on this document, if there is one.
 *
 * Without it every press of Pay opened *another* Paystack transaction.
 *
 * Seen twice on real invoices: two references 363ms apart, which is a browser
 * submitting the form twice rather than a person, and two 61 seconds apart,
 * which is a person. Each left a stray `initialised` row behind, and each was
 * a live transaction a client could have paid — two open transactions for one
 * invoice is how the same bill gets paid twice.
 *
 * Matched on the amount as well as the document, so that a part payment
 * landing in between does not hand somebody a checkout for a figure that is
 * no longer owed.
 */
export async function liveCardCheckoutFor(
  documentId: string,
  amountKobo: number,
): Promise<{ reference: string; checkoutUrl: string } | null> {
  const { rows } = await db().query<{ reference: string; checkout_url: string | null }>(
    `SELECT reference, raw_verify_json ->> 'checkoutUrl' AS checkout_url
       FROM payments
      WHERE document_id = $1
        AND provider = 'paystack'
        AND status = 'initialised'
        AND created_at > now() - ($3 || ' minutes')::interval
        AND COALESCE(invoice_amount_kobo, client_total_kobo) = $2
        AND raw_verify_json ->> 'checkoutUrl' IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [documentId, amountKobo, String(CHECKOUT_REUSE_MINUTES)],
  );

  const r = rows[0];
  return r?.checkout_url ? { reference: r.reference, checkoutUrl: r.checkout_url } : null;
}
