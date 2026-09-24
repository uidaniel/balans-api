/**
 * Which processor a payment belongs to, and how to ask it what happened
 * (International PRD section 8: "implement through the existing payment
 * provider interface; no Paystack logic outside the provider module").
 *
 * There was no interface to speak of — `confirmPayment` called Monnify
 * directly, with the verifier as an injectable argument for tests. That
 * argument turns out to be the interface: everything `confirmPayment` does
 * afterwards is provider-agnostic and is exactly what section 8 asks for.
 * Verify by API, refuse a reference that does not match, refuse a currency
 * that is not NGN, refuse an amount short of what was asked, be idempotent
 * against redelivery, and send anything that disagrees to `needs_review`.
 *
 * So Paystack does not get a second confirmation path. It gets an adapter,
 * and the rules stay in one place — which is the only way they stay the same
 * rules. A second copy of "is this really paid?" is a second answer waiting
 * to drift from the first.
 *
 * The shape both sides speak is Monnify's `VerifiedTransaction`, because it
 * already exists and is already what every caller reads. Its field names are
 * Monnify's, which is a small cost against rewriting the confirmation path.
 */

import type { VerifiedTransaction, VerifyResult, PaymentStatus } from "./monnify.ts";
import { verifyTransaction as verifyMonnify } from "./monnify.ts";
import { verifyTransaction as verifyPaystack } from "./paystack.ts";

export type Provider = "monnify" | "paystack";

/** Which processor collects for an invoice in this currency (section 8). */
export const providerFor = (currency: string): Provider =>
  currency === "NGN" ? "monnify" : "paystack";

/**
 * Paystack's statuses in Monnify's vocabulary.
 *
 * `abandoned` is the one worth naming: Paystack answers "Verification
 * successful" for a transaction nobody ever paid, and calls it abandoned. The
 * envelope's success is about the lookup, not the money, and a mapping that
 * lost that distinction would mark every initialised payment as paid.
 *
 * There is no `OVERPAID` and no `PARTIALLY_PAID` here. A card is charged the
 * exact amount it was asked for or it is not charged, so neither state can
 * arise — and inventing a mapping for a state the provider cannot produce is
 * how a branch nobody has ever run ends up deciding something.
 */
const STATUS: Record<string, PaymentStatus> = {
  success: "PAID",
  failed: "FAILED",
  abandoned: "ABANDONED",
  pending: "PENDING",
  reversed: "REVERSED",
  unknown: "PENDING",
};

/**
 * Paystack's verify, in the shape the confirmation path already reads.
 *
 * Both references are ours. Paystack verifies by the reference we set at
 * initialisation and has no second identifier of its own to quote back, so
 * the reference-match check in `confirmPayment` compares ours against ours
 * and passes by construction. That is honest rather than hollow: the check
 * exists because Monnify echoes a *different* string and a mismatch there
 * means we are about to credit the wrong document. Here there is no second
 * string to disagree with.
 *
 * What is emphatically still checked is the currency and the amount, and
 * those are the ones that matter on this path: a card charged in the wrong
 * currency, or for less than the invoice, must never mark anything paid.
 */
export async function verifyWithPaystack(
  reference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const res = await verifyPaystack(reference, fetchImpl);
  if (!res.ok) return { ok: false, message: res.message };

  const t = res.transaction;

  const transaction: VerifiedTransaction = {
    transactionReference: t.reference,
    paymentReference: t.reference,
    paymentStatus: STATUS[t.status] ?? "PENDING",
    amountPaidKobo: t.amountKobo,
    totalPayableKobo: t.amountKobo,
    /*
     * What actually reaches the subaccount, after Paystack's cut.
     *
     * Null when the fee is not known yet, which it is not until the card has
     * been charged — Paystack cannot know where a card is from until it is
     * used, so the fee on an unpaid transaction is null and the estimate on
     * the draft came from configuration. Null rather than the gross amount,
     * because "we do not know" and "nothing was taken" are different facts
     * and only one of them is true.
     */
    settlementAmountKobo: t.feeKobo === null ? null : t.amountKobo - t.feeKobo,
    currency: t.currency,
    paymentMethod: t.channel,
    paidOn: t.paidAt ? t.paidAt.toISOString() : null,
  };

  return { ok: true, transaction, raw: t.raw };
}

/** The verifier for a provider, for `confirmPayment`'s third argument. */
export function verifierFor(provider: Provider): (reference: string) => Promise<VerifyResult> {
  return provider === "paystack" ? verifyWithPaystack : verifyMonnify;
}
