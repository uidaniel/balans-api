/**
 * How a document asks to be paid: the sender's bank details, or a link.
 *
 * The rule, as decided on 25 September 2026 against the Bank Details
 * Invoices addendum: an invoice priced in naira is paid by transfer straight
 * to the freelancer's own verified account, and carries that account instead
 * of a payment link. An invoice priced abroad keeps its card link, because a
 * client abroad pays by card and cannot send naira to a Nigerian account.
 * There is no choice to make and no question asked.
 *
 * What that costs, said once here so nobody rediscovers it: nothing runs
 * through a processor on a naira invoice, so there is no webhook to confirm
 * it, no fee on it, and it becomes paid only when the sender says so
 * ("Tolu paid invoice 16" — see `recordOfflinePayment`).
 *
 * The account is copied onto the document at the moment it is sent, from the
 * one verified at onboarding (never typed per invoice), and never read live
 * afterwards: a bank change (F17) must not rewrite an invoice a client
 * already holds. The encrypted number is copied as it is, so the clear number
 * never passes through a query.
 */

import type pg from "pg";
import { db } from "../db/pool.ts";
import { decrypt } from "../lib/crypto.ts";

export type Delivery = "payment_link" | "bank_details";

export type BankDetails = {
  bankName: string;
  accountName: string;
  accountNumber: string;
  last4: string;
};

/** Which way a document of this type and currency is paid. */
export function deliveryFor(type: string, currency: string): Delivery {
  // A quote is not paid at all; the invoice it becomes is decided on its own.
  if (type !== "invoice" && type !== "payment_request") return "payment_link";
  return currency === "NGN" ? "bank_details" : "payment_link";
}

/**
 * Stamps the sender's verified account onto a document, inside the caller's
 * transaction. Returns what was stamped, or null if there was no active
 * account to stamp — in which case the document keeps its link rather than
 * going out telling a client to pay with no account on it.
 */
export async function attachBankDetails(
  c: pg.PoolClient,
  documentId: string,
  userId: string,
): Promise<BankDetails | null> {
  const { rows } = await c.query<{
    bank_details_bank_name: string;
    bank_details_account_name: string;
    bank_details_account_last4: string;
    bank_details_account_number_encrypted: Buffer;
  }>(
    `UPDATE documents d
        SET delivery_type = 'bank_details',
            bank_details_bank_name = b.bank_name,
            bank_details_account_name = b.account_name,
            bank_details_account_last4 = b.account_last4,
            bank_details_account_number_encrypted = b.account_number_encrypted
       FROM bank_accounts b
      WHERE d.id = $1 AND b.user_id = $2 AND b.status = 'active'
      RETURNING d.bank_details_bank_name, d.bank_details_account_name,
                d.bank_details_account_last4, d.bank_details_account_number_encrypted`,
    [documentId, userId],
  );
  const r = rows[0];
  return r ? fromRow(r) : null;
}

/** The account stamped on a document, or null for one sent with a link. */
export async function bankDetailsOf(documentId: string): Promise<BankDetails | null> {
  const { rows } = await db().query<{
    bank_details_bank_name: string | null;
    bank_details_account_name: string | null;
    bank_details_account_last4: string | null;
    bank_details_account_number_encrypted: Buffer | null;
  }>(
    `SELECT bank_details_bank_name, bank_details_account_name,
            bank_details_account_last4, bank_details_account_number_encrypted
       FROM documents WHERE id = $1 AND delivery_type = 'bank_details'`,
    [documentId],
  );
  const r = rows[0];
  return r && r.bank_details_account_number_encrypted ? fromRow(r as Parameters<typeof fromRow>[0]) : null;
}

function fromRow(r: {
  bank_details_bank_name: string;
  bank_details_account_name: string;
  bank_details_account_last4: string;
  bank_details_account_number_encrypted: Buffer;
}): BankDetails {
  return {
    bankName: r.bank_details_bank_name,
    accountName: r.bank_details_account_name,
    accountNumber: decrypt(r.bank_details_account_number_encrypted),
    last4: r.bank_details_account_last4,
  };
}

/** The note every bank-details document carries, for the client's sake too. */
export const untrackedNote = (business: string): string =>
  `Payments made directly to this account are not tracked automatically. Ask ${business} for confirmation.`;
