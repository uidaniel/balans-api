/**
 * Loading a document for its public page (PRD F9).
 *
 * The token is the only key a client has, and it is all they should need: no
 * account, no login, no app. That makes this the one query in the system that
 * runs for a stranger, so it reads exactly what the page needs and nothing
 * else. The user's phone number, their email, their bank details and their
 * other clients are not in the select list, and cannot be leaked by a template
 * that renders more than it meant to.
 */

import { db } from "../db/pool.ts";
import type { Civil } from "../../core/dates.ts";
import { partsFor, nextPayable, type Part } from "./parts.ts";
import type { Foreign } from "../../core/currency.ts";
import { decrypt } from "../lib/crypto.ts";
import type { BankDetails } from "./bank-details.ts";

export type PublicStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "overdue"
  | "part_paid"
  | "paid"
  | "cancelled"
  | "accepted"
  | "converted"
  | "expired";

export type PublicDocument = {
  id: string;
  userId: string;
  type: "invoice" | "quote" | "payment_request" | "sample";
  number: number;
  status: PublicStatus;
  /** Whose business is billing. The only thing about the user a client sees. */
  businessName: string;
  clientName: string;
  lines: {
    description: string;
    qty: number;
    unitAmountKobo: number;
    amountKobo: number;
    /**
     * What this line was quoted at abroad, in cents or pence.
     *
     * Optional rather than nullable, because on a naira invoice it is not a
     * value that happens to be absent — there was never a second currency for
     * it to be in.
     */
    originalAmountMinor?: number | null;
  }[];
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  passFeesToClient: boolean;
  dueDate: Civil | null;
  issueDate: Civil | null;
  notes: string | null;
  /** Where the user's share settles. Absent means the page cannot take money. */
  subAccountCode: string | null;
  /**
   * Whether the sender has a bank account in force at all.
   *
   * What a card payment needs: its Paystack subaccount is made from this
   * account the first time a client pays (see paystack-subaccount.ts), so
   * the Monnify code above is not asked about. Optional so older fixtures
   * without it read as "has one only if it has a Monnify code".
   */
  hasPayoutAccount?: boolean;
  /** "BL-0019": what the client reads as the number (see client-number.ts). */
  ref?: string | null;
  plan: "free" | "pro";
  /** F7: empty for an ordinary invoice, two or more for a deposit. */
  parts: Part[];
  /**
   * The price as agreed, when it was not agreed in naira.
   *
   * Every kobo figure above is still what is charged — the card is debited in
   * naira and the client's own bank converts. This is the number the two
   * people shook hands on, and it is the one that goes at the top of the
   * page, because a client who agreed to $500 should not have to work out
   * whether ₦663,500 is the same thing.
   */
  foreign: {
    currency: Foreign;
    amountMinor: number;
    /** Only ever shown as "today's rate" context, never as a price. */
    rate: number;
  } | null;
  /** The sender's own account, on a naira invoice sent with bank details. */
  bank?: BankDetails | null;
};

const civil = (d: Date | null): Civil | null =>
  d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null;

export async function findByToken(token: string): Promise<PublicDocument | null> {
  // A token is 32 hex characters from a CSPRNG. Checking the shape first means
  // a scanner probing /i/admin never reaches the database at all.
  if (!/^[0-9a-f]{32}$/.test(token)) return null;

  const { rows } = await db().query<{
    id: string;
    user_id: string;
    type: PublicDocument["type"];
    number: number;
    status: PublicStatus;
    subtotal_kobo: number;
    vat_kobo: number;
    total_kobo: number;
    amount_paid_kobo: number;
    pass_fees_to_client: boolean;
    due_date: Date | null;
    valid_until: Date | null;
    issue_date: Date | null;
    notes: string | null;
    business_name: string | null;
    plan: "free" | "pro";
    currency: Foreign | "NGN";
    original_amount_minor: number | null;
    fx_rate: string | null;
    client_name: string;
    sub_account_code: string | null;
    has_payout_account: boolean;
    ref: string | null;
    delivery_type: "payment_link" | "bank_details";
    bank_details_bank_name: string | null;
    bank_details_account_name: string | null;
    bank_details_account_last4: string | null;
    bank_details_account_number_encrypted: Buffer | null;
  }>(
    `SELECT d.id, d.user_id, d.type, d.number, d.ref, d.status,
            d.subtotal_kobo, d.vat_kobo, d.total_kobo, d.amount_paid_kobo,
            d.pass_fees_to_client, d.due_date, d.valid_until, d.issue_date, d.notes,
            d.currency, d.original_amount_minor, d.fx_rate,
            d.delivery_type, d.bank_details_bank_name, d.bank_details_account_name,
            d.bank_details_account_last4, d.bank_details_account_number_encrypted,
            u.business_name, u.plan,
            c.name AS client_name,
            b.subaccount_code AS sub_account_code,
            (b.id IS NOT NULL) AS has_payout_account
       FROM documents d
       JOIN users u   ON u.id = d.user_id
       JOIN clients c ON c.id = d.client_id
       -- The account in force now, not one scheduled for tomorrow: F17's
       -- 24-hour delay is only a delay if every payment path honours it.
       LEFT JOIN bank_accounts b
              ON b.user_id = d.user_id
             AND b.status = 'active'
             AND (b.effective_at IS NULL OR b.effective_at <= now())
      WHERE d.public_token = $1 AND d.status <> 'draft'
      LIMIT 1`,
    [token],
  );

  const r = rows[0];
  if (!r) return null;

  const { rows: items } = await db().query<{
    description: string;
    qty: string;
    unit_amount_kobo: number;
    amount_kobo: number;
    original_amount_minor: number | null;
  }>(
    `SELECT description, qty, unit_amount_kobo, amount_kobo, original_amount_minor
       FROM line_items WHERE document_id = $1 ORDER BY position`,
    [r.id],
  );

  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    number: r.number,
    ref: r.ref,
    status: r.status,
    businessName: r.business_name ?? "A Balans user",
    clientName: r.client_name,
    lines: items.map((i) => ({
      description: i.description,
      qty: Number(i.qty),
      unitAmountKobo: i.unit_amount_kobo,
      amountKobo: i.amount_kobo,
      originalAmountMinor: i.original_amount_minor,
    })),
    subtotalKobo: r.subtotal_kobo,
    vatKobo: r.vat_kobo,
    totalKobo: r.total_kobo,
    amountPaidKobo: r.amount_paid_kobo,
    passFeesToClient: r.pass_fees_to_client,
    dueDate: civil(r.due_date ?? r.valid_until),
    issueDate: civil(r.issue_date),
    notes: r.notes,
    subAccountCode: r.sub_account_code,
    hasPayoutAccount: r.has_payout_account,
    plan: r.plan,
    // The account stamped on it when it was sent — never the live one, so a
    // bank change cannot redirect money a client is about to send.
    bank:
      r.delivery_type === "bank_details" && r.bank_details_account_number_encrypted
        ? {
            bankName: r.bank_details_bank_name ?? "",
            accountName: r.bank_details_account_name ?? "",
            accountNumber: decrypt(r.bank_details_account_number_encrypted),
            last4: r.bank_details_account_last4 ?? "",
          }
        : null,
    parts: await partsFor(r.id),
    foreign:
      r.currency === "NGN" || r.original_amount_minor === null || r.fx_rate === null
        ? null
        : {
            currency: r.currency,
            amountMinor: r.original_amount_minor,
            rate: Number(r.fx_rate),
          },
  };
}

/**
 * Records the first time a client opened the page (section 6).
 *
 * Only `sent` moves to `viewed`. An overdue or part-paid document that gets
 * opened again must not travel backwards, and a paid one certainly must not.
 */
export async function markViewed(id: string): Promise<void> {
  await db().query(
    `UPDATE documents
        SET status = 'viewed', viewed_at = COALESCE(viewed_at, now())
      WHERE id = $1 AND status = 'sent'`,
    [id],
  );
}

/** What is still owed on the whole document. */
export const outstandingKobo = (d: PublicDocument): number =>
  Math.max(0, d.totalKobo - d.amountPaidKobo);

/**
 * What the Pay button charges (F7).
 *
 * The next unpaid part when the document has parts, the whole balance
 * otherwise. Only the next one: a client who could pay the balance first
 * would leave the user chasing the deposit, which is the opposite of why
 * somebody asks for a deposit.
 */
export function payableNowKobo(d: PublicDocument): number {
  if (!d.parts.length) return outstandingKobo(d);
  const next = nextPayable(d.parts);
  return next ? next.amountKobo : 0;
}

/** The label for that button, so the client knows which part they are paying. */
export const payableLabel = (d: PublicDocument): string | null =>
  d.parts.length ? (nextPayable(d.parts)?.label ?? null) : null;

/** Whether the page should show a Pay button at all. */
export function payable(d: PublicDocument): { ok: true } | { ok: false; why: string } {
  /*
   * A quote says which kind of quote it is.
   *
   * This asked "is it a quote?" before it asked anything about its state, so
   * every quote got the same answer and the page told the client to reply and
   * accept it. That is wrong in three ways at once: an expired quote invites
   * acceptance of a price that has lapsed, a cancelled one invites acceptance
   * of something withdrawn, and a converted one invites acceptance of work
   * that has already been invoiced — which is how a client accepts twice and
   * a freelancer bills twice.
   *
   * None of them can be paid here either way, so this is about what the page
   * says, not what it lets anybody do.
   */
  if (d.type === "quote") {
    if (d.status === "cancelled") return { ok: false, why: "quote_cancelled" };
    if (d.status === "expired") return { ok: false, why: "quote_expired" };
    // "accepted" is the same story from the client's side: they have already
    // said yes and the invoice is either here or coming.
    if (d.status === "converted" || d.status === "accepted") {
      return { ok: false, why: "quote_converted" };
    }
    return { ok: false, why: "quote" };
  }

  if (d.type === "sample") return { ok: false, why: "sample" };
  if (d.status === "cancelled") return { ok: false, why: "cancelled" };
  if (d.status === "paid" || outstandingKobo(d) === 0) return { ok: false, why: "paid" };
  // Every part settled but the document not yet marked paid: nothing to take.
  if (d.parts.length && payableNowKobo(d) === 0) return { ok: false, why: "paid" };
  // A naira invoice is paid by transfer to the sender's own account, which
  // the page shows instead of a Pay button (see bank-details.ts).
  if (d.bank) return { ok: false, why: "bank_details" };
  /*
   * Priced abroad: a card payment through Paystack, settling to the sender's
   * own bank account through a subaccount made on the first payment. So it
   * needs a bank account, not a Monnify subaccount. Asking for the Monnify
   * one turned every dollar invoice into "Online payment is not set up" once
   * setup stopped making them, on 26 September 2026.
   */
  if (d.foreign) {
    return d.hasPayoutAccount || d.subAccountCode ? { ok: true } : { ok: false, why: "no_account" };
  }
  // Without a subaccount the money has nowhere to settle but our own wallet,
  // which is the one thing Balans must never do.
  if (!d.subAccountCode) return { ok: false, why: "no_account" };
  return { ok: true };
}
