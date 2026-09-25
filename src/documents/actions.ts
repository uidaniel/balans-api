/**
 * Things done to a document that already exists (PRD F5, F6).
 *
 * Cancelling, resending, converting a quote. Each is a small thing that the
 * bot previously said was "not built yet", and each has one rule that makes it
 * safe:
 *
 *   - Cancel is refused once any payment exists. Money that arrived does not
 *     un-arrive because somebody typed "cancel invoice 14".
 *   - Resend re-sends what is already there. It never renumbers and never
 *     re-renders from changed data, so the client gets the document they were
 *     already sent.
 *   - Convert copies a quote into an invoice draft and links the two. A quote
 *     converts once, so the same work cannot be billed twice by accident.
 */

import { randomBytes } from "node:crypto";
import { db, tx } from "../db/pool.ts";
import type { Civil } from "../../core/dates.ts";
import { attachBankDetails, deliveryFor, type BankDetails } from "./bank-details.ts";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; why: string };

/* -------------------------------------------------------------------------- */
/* Cancel (F6)                                                                */
/* -------------------------------------------------------------------------- */

export type Cancelled = { number: number; type: string; clientName: string };

/**
 * "Cancelling is allowed when no payment exists."
 *
 * The check and the update are one statement: a payment landing between a
 * read and a write is exactly the case this has to survive, and a conditional
 * update is the only way to be sure.
 */
export async function cancelDocument(
  userId: string,
  number: number,
): Promise<ActionResult<Cancelled>> {
  const { rows } = await db().query<{
    id: string;
    status: string;
    type: string;
    amount_paid_kobo: number;
    client_name: string;
  }>(
    `SELECT d.id, d.status, d.type, d.amount_paid_kobo, c.name AS client_name
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.number = $2 AND d.status <> 'draft'
      ORDER BY d.created_at DESC LIMIT 1`,
    [userId, number],
  );

  const doc = rows[0];
  if (!doc) return { ok: false, why: "not_found" };
  if (doc.status === "cancelled") return { ok: false, why: "already_cancelled" };
  if (doc.status === "paid" || doc.amount_paid_kobo > 0) return { ok: false, why: "has_payment" };

  const { rowCount } = await db().query(
    `UPDATE documents
        SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1
        AND amount_paid_kobo = 0
        AND status NOT IN ('paid', 'part_paid', 'cancelled')
        -- A payment in flight counts: it may land a second from now.
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.document_id = $1 AND p.status IN ('success', 'initialised')
        )`,
    [doc.id],
  );

  if (rowCount === 0) return { ok: false, why: "has_payment" };

  // Nothing pending should chase a cancelled invoice.
  await db().query(
    `UPDATE reminders SET status = 'cancelled' WHERE document_id = $1 AND status = 'pending'`,
    [doc.id],
  );

  return { ok: true, value: { number, type: doc.type, clientName: doc.client_name } };
}

/* -------------------------------------------------------------------------- */
/* Resend (F6)                                                                */
/* -------------------------------------------------------------------------- */

export type Resendable = {
  id: string;
  number: number | null;
  type: string;
  clientName: string;
  totalKobo: number;
  amountPaidKobo: number;
  dueDate: Civil | null;
  publicToken: string | null;
  status: string;
};

/** "Resend invoice 14 returns the current PDF and link." */
export async function findForResend(
  userId: string,
  number: number,
): Promise<ActionResult<Resendable>> {
  const { rows } = await db().query<{
    id: string;
    number: number | null;
    type: string;
    status: string;
    total_kobo: number;
    amount_paid_kobo: number;
    due_date: Date | null;
    valid_until: Date | null;
    public_token: string | null;
    client_name: string;
  }>(
    `SELECT d.id, d.number, d.type, d.status, d.total_kobo, d.amount_paid_kobo,
            d.due_date, d.valid_until, d.public_token, c.name AS client_name
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.number = $2 AND d.status <> 'draft'
      ORDER BY d.created_at DESC LIMIT 1`,
    [userId, number],
  );

  const r = rows[0];
  if (!r) return { ok: false, why: "not_found" };
  if (!r.public_token) return { ok: false, why: "no_link" };

  const d = r.due_date ?? r.valid_until;
  return {
    ok: true,
    value: {
      id: r.id,
      number: r.number,
      type: r.type,
      clientName: r.client_name,
      totalKobo: r.total_kobo,
      amountPaidKobo: r.amount_paid_kobo,
      dueDate: d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null,
      publicToken: r.public_token,
      status: r.status,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Convert a quote (F5)                                                       */
/* -------------------------------------------------------------------------- */

export type Converted = {
  invoiceNumber: number;
  quoteNumber: number;
  clientName: string;
  totalKobo: number;
  /** The account a naira invoice was stamped with, or null for a link. */
  bank: BankDetails | null;
};

/**
 * "Convert quote 12 creates an invoice draft prefilled from the quote and
 * links the two. A quote can be converted once unless the resulting invoice is
 * cancelled."
 *
 * Copied, not moved: the quote stays exactly as the client saw it, and the
 * invoice is a new document with its own number and its own link. An accepted
 * quote is a record of what was agreed, and overwriting it would erase that.
 */
export async function convertQuote(
  userId: string,
  quoteNumber: number,
  dueDate: Civil | null,
): Promise<ActionResult<Converted>> {
  return tx(async (c) => {
    await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

    const { rows } = await c.query<{
      id: string;
      client_id: string;
      status: string;
      subtotal_kobo: number;
      vat_kobo: number;
      total_kobo: number;
      pass_fees_to_client: boolean;
      notes: string | null;
      client_name: string;
      currency: string;
      original_amount_minor: string | null;
      fx_rate: string | null;
      fx_source: string | null;
      fx_fetched_at: Date | null;
    }>(
      `SELECT d.id, d.client_id, d.status, d.subtotal_kobo, d.vat_kobo, d.total_kobo,
              d.pass_fees_to_client, d.notes, c.name AS client_name,
              d.currency, d.original_amount_minor, d.fx_rate, d.fx_source, d.fx_fetched_at
         FROM documents d JOIN clients c ON c.id = d.client_id
        WHERE d.user_id = $1 AND d.type = 'quote' AND d.number = $2
        ORDER BY d.created_at DESC LIMIT 1`,
      [userId, quoteNumber],
    );

    const quote = rows[0];
    if (!quote) return { ok: false as const, why: "not_found" };
    if (quote.status === "cancelled") return { ok: false as const, why: "cancelled" };

    // Already converted, and the invoice that came of it still stands.
    const { rows: existing } = await c.query<{ number: number | null; status: string }>(
      `SELECT number, status FROM documents
        WHERE parent_id = $1 AND type = 'invoice' AND status <> 'cancelled'`,
      [quote.id],
    );
    if (existing.length) {
      return { ok: false as const, why: `already_converted:${existing[0]!.number ?? "?"}` };
    }

    // GREATEST, so the user's chosen start only ever skips forward. Set below
    // what has already been issued it changes nothing, and numbers can never
    // repeat or go backwards whatever is configured.
    const { rows: numbered } = await c.query<{ next: number }>(
      `SELECT GREATEST(
                COALESCE(MAX(d.number), 0) + 1,
                (SELECT u.invoice_number_start FROM users u WHERE u.id = $1)
              ) AS next
         FROM documents d WHERE d.user_id = $1 AND d.type = 'invoice'`,
      [userId],
    );
    const number = numbered[0]!.next;
    const token = randomBytes(16).toString("hex");

    const { rows: made } = await c.query<{ id: string }>(
      `INSERT INTO documents
         (user_id, client_id, type, number, status, subtotal_kobo, vat_kobo, total_kobo,
          pass_fees_to_client, notes, parent_id, public_token, issue_date, due_date, sent_at,
          currency, original_amount_minor, fx_rate, fx_source, fx_fetched_at)
       VALUES ($1, $2, 'invoice', $3, 'sent', $4, $5, $6, $7, $8, $9, $10,
               CURRENT_DATE, $11::date, now(),
               $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        userId,
        quote.client_id,
        number,
        quote.subtotal_kobo,
        quote.vat_kobo,
        quote.total_kobo,
        quote.pass_fees_to_client,
        quote.notes,
        quote.id,
        token,
        dueDate ? `${dueDate.y}-${String(dueDate.m).padStart(2, "0")}-${String(dueDate.d).padStart(2, "0")}` : null,
        /*
         * The currency comes across with the money, and so does the rate it
         * was struck at.
         *
         * Without these the invoice defaulted to naira, and it did so
         * silently: `documents_foreign_locks_its_rate` only fires when the
         * currency is *not* NGN, so dropping the currency is the one way to
         * satisfy the constraint meant to catch exactly this. A client who
         * agreed £500 was sent an invoice headed ₦963,066.70 with no mention
         * of pounds, and `doc.foreign` being null meant the page offered a
         * Nigerian bank transfer rather than a card — which is not a worse
         * way for somebody abroad to pay, it is no way at all.
         *
         * The rate is the quote's, not today's. Acceptance criterion 6: the
         * rate is locked when the document is made. Re-striking it here would
         * charge a number the client never agreed to, days after they agreed
         * it, which is the whole reason it is stored rather than looked up.
         */
        quote.currency,
        quote.original_amount_minor,
        quote.fx_rate,
        quote.fx_source,
        quote.fx_fetched_at,
      ],
    );
    const invoiceId = made[0]!.id;

    await c.query(
      // The per-line foreign figures too, or a copied £500 invoice itemises
      // in naira under a pound headline.
      `INSERT INTO line_items (document_id, position, description, qty, unit_amount_kobo, amount_kobo,
                               original_unit_amount_minor, original_amount_minor)
       SELECT $1, position, description, qty, unit_amount_kobo, amount_kobo,
              original_unit_amount_minor, original_amount_minor
         FROM line_items WHERE document_id = $2`,
      [invoiceId, quote.id],
    );

    /*
     * The payment plan comes across with the work.
     *
     * A quote that said "50% deposit" is the thing the client agreed to, and
     * the invoice that comes of it has to ask for the same thing. Copied with
     * every part reset to its starting state: the quote was never payable, so
     * nothing on it can have been paid, and the first part opens here exactly
     * as it would on a fresh invoice.
     */
    await c.query(
      `INSERT INTO payment_parts (document_id, position, label, amount_kobo, status, due_date)
       SELECT $1, position, label, amount_kobo,
              CASE WHEN position = 0 THEN 'payable' ELSE 'pending' END::part_status,
              due_date
         FROM payment_parts WHERE document_id = $2 ORDER BY position`,
      [invoiceId, quote.id],
    );

    await c.query(`UPDATE documents SET status = 'converted' WHERE id = $1`, [quote.id]);

    // The invoice a naira quote becomes is paid to the sender's account, like
    // any other naira invoice (see bank-details.ts). A quote abroad keeps its
    // card link.
    const bank =
      deliveryFor("invoice", quote.currency) === "bank_details"
        ? await attachBankDetails(c, invoiceId, userId)
        : null;

    return {
      ok: true as const,
      value: {
        invoiceNumber: number,
        quoteNumber,
        clientName: quote.client_name,
        totalKobo: quote.total_kobo,
        bank,
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Stop reminders (F13)                                                       */
/* -------------------------------------------------------------------------- */

/** "Users can say 'stop reminders for invoice 14'." */
export async function stopReminders(
  userId: string,
  number: number | null,
): Promise<number> {
  const { rowCount } = await db().query(
    number === null
      ? `UPDATE reminders SET status = 'cancelled'
          WHERE status = 'pending'
            AND document_id IN (SELECT id FROM documents WHERE user_id = $1)`
      : `UPDATE reminders SET status = 'cancelled'
          WHERE status = 'pending'
            AND document_id IN (
              SELECT id FROM documents WHERE user_id = $1 AND number = $2
            )`,
    number === null ? [userId] : [userId, number],
  );
  return rowCount ?? 0;
}
