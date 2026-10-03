/**
 * What a processor says about a payment, in one shape for `confirmPayment`.
 */

/**
 * Where a transaction stands, in the vocabulary the confirmation path reads
 * (first Monnify's, kept when Monnify was retired; Paystack's statuses are
 * mapped onto it in provider.ts).
 *
 * Only PAID and OVERPAID mean money arrived. PARTIALLY_PAID is a real state
 * here — a client can pay a bank transfer short — and it is not "paid".
 */
export type PaymentStatus =
  | "PAID"
  | "OVERPAID"
  | "PARTIALLY_PAID"
  | "PENDING"
  | "ABANDONED"
  | "CANCELLED"
  | "FAILED"
  | "REVERSED"
  | "EXPIRED";

export type VerifiedTransaction = {
  transactionReference: string;
  /** Ours, the one we set at initialisation. */
  paymentReference: string;
  paymentStatus: PaymentStatus;
  /** Kobo. Converted here so no caller ever sees a decimal amount. */
  amountPaidKobo: number;
  totalPayableKobo: number;
  /** What actually settles to the subaccount, after the processor's cut. */
  settlementAmountKobo: number | null;
  currency: string;
  paymentMethod: string | null;
  paidOn: string | null;
};

export type VerifyResult =
  | { ok: true; transaction: VerifiedTransaction; raw: unknown }
  | { ok: false; message: string };
