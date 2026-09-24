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
import type { Provider } from "../payments/provider.ts";

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
  /**
   * Which processor is collecting this one.
   *
   * Defaults to Monnify, which is every naira invoice and so nearly all of
   * them. A payment recorded under the wrong provider is one the nightly
   * reconciliation looks for in the wrong place — and one the webhook for the
   * other provider would find and try to confirm.
   */
  provider?: "monnify" | "paystack";
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
     VALUES ($1, $2, $3, $4, $5, $9, $6, $7, 'user', 'initialised', $8, $10)
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
      JSON.stringify({
        providerReference: p.providerReference,
        stage: "initialised",
        ...(p.checkoutUrl ? { checkoutUrl: p.checkoutUrl } : {}),
      }),
      p.invoiceAmountKobo,
      p.provider ?? "monnify",
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
/**
 * The live account for a stage of this document, if one is still good.
 *
 * `amountKobo` is what the stage is worth — what the plan says and what the
 * page calls the balance — not what the client is charged for it. The two are
 * the same until fees are passed on, and then the client is charged the stage
 * grossed up by the processor's cut.
 *
 * This matched on the charged figure while both callers passed the stage, so
 * on every invoice that passes fees on it found nothing, twice over:
 *
 *   - the Pay button's "there is already an account for this" check failed,
 *     and minted a second one. Monnify matches a transfer on the account and
 *     the amount, so two live accounts for the same balance is a way to lose
 *     somebody's money — which is exactly what the check above it exists to
 *     prevent, and it had not worked on a fee-passing invoice.
 *   - and the page could not find the account it had just created, so
 *     pressing Pay reloaded the invoice with no panel on it at all.
 *
 * The second one hid the first: while the Pay button rendered the panel
 * itself, nobody noticed that nothing could look it up afterwards.
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
        AND COALESCE(invoice_amount_kobo, client_total_kobo) = $2
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
): Promise<{ reference: string; providerReference: string; provider: Provider }[]> {
  const { rows } = await db().query<{
    reference: string;
    provider_reference: string;
    provider: string;
  }>(
    `SELECT reference, provider_reference, provider
       FROM payments WHERE document_id = $1 AND status = 'initialised'`,
    [documentId],
  );
  return rows.map((r) => ({
    reference: r.reference,
    providerReference: r.provider_reference,
    /*
     * Which processor to ask about it, and it is not optional.
     *
     * Confirming a payment means asking the provider that took it. Asked of
     * the wrong one the reference simply does not exist, so a Paystack
     * payment polled against Monnify comes back unverifiable for ever — the
     * page waits, the freelancer is never told, and the money is sitting in
     * their subaccount the whole time.
     *
     * Anything that is not 'paystack' is Monnify, including the older rows
     * written before this column meant anything.
     */
    provider: r.provider === "paystack" ? "paystack" : "monnify",
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
 * The transfer side has always done this — `liveTransferFor` hands back the
 * account that was already issued, because somebody returning from their
 * banking app must meet the same account they copied. The card side had no
 * equivalent, so every press of Pay opened *another* Paystack transaction.
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
