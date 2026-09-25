/**
 * A payment the sender tells us about (Bank Details Invoices addendum,
 * section 5; the old F12).
 *
 * A naira invoice is paid by transfer straight to the sender's account, so
 * nothing ever reports it to us. The sender does: "Zenith paid invoice 16".
 * Any invoice, any plan, sent with or without a link — a client who paid
 * around a link is still a paid invoice, and the record is worth more to the
 * sender than how the money moved.
 *
 * Their word is enough at v1: no bank statement is matched. What keeps it
 * honest is that it is kept apart: `method = 'offline'`, provider `offline`,
 * no fee of any kind, and it is excluded from processed volume wherever that
 * is counted, because it is business the sender did, not money Balans moved.
 */

import { randomUUID } from "node:crypto";
import { db, tx } from "../db/pool.ts";
import { settleParts } from "../documents/parts.ts";

export type OfflinePaid =
  | {
      ok: true;
      paymentId: string;
      documentId: string;
      number: number | null;
      clientName: string;
      paidKobo: number;
    }
  | { ok: false; why: "not_found" | "not_payable" | "already_paid" };

/**
 * Marks what is still owed on an invoice as paid, by the sender's word.
 *
 * The whole balance: "Zenith paid invoice 16" means paid, and a part payment
 * reported this way would need an amount this sentence does not carry.
 */
export async function recordOfflinePayment(userId: string, documentId: string): Promise<OfflinePaid> {
  return tx(async (c) => {
    const { rows } = await c.query<{
      id: string;
      type: string;
      status: string;
      number: number | null;
      total_kobo: number;
      amount_paid_kobo: number;
      client_name: string;
    }>(
      `SELECT d.id, d.type, d.status, d.number, d.total_kobo, d.amount_paid_kobo, cl.name AS client_name
         FROM documents d JOIN clients cl ON cl.id = d.client_id
        WHERE d.id = $1 AND d.user_id = $2
        FOR UPDATE OF d`,
      [documentId, userId],
    );
    const d = rows[0];
    if (!d) return { ok: false as const, why: "not_found" as const };
    if (d.type !== "invoice" && d.type !== "payment_request") return { ok: false as const, why: "not_payable" as const };
    if (d.status === "cancelled" || d.status === "draft") return { ok: false as const, why: "not_payable" as const };

    const owed = d.total_kobo - d.amount_paid_kobo;
    if (owed <= 0 || d.status === "paid") return { ok: false as const, why: "already_paid" as const };

    const { rows: made } = await c.query<{ id: string }>(
      `INSERT INTO payments
         (document_id, provider, reference, amount_kobo, client_total_kobo, invoice_amount_kobo,
          provider_fee_kobo, balans_fee_kobo, channel, status, method, paid_at)
       VALUES ($1, 'offline', $2, $3, $3, $3, 0, 0, 'OFFLINE', 'success', 'offline', now())
       RETURNING id`,
      [documentId, `offline_${randomUUID()}`, owed],
    );

    await settleParts(documentId, owed).catch(() => undefined);

    await c.query(
      `UPDATE documents
          SET amount_paid_kobo = total_kobo, status = 'paid', paid_at = COALESCE(paid_at, now())
        WHERE id = $1`,
      [documentId],
    );

    return {
      ok: true as const,
      paymentId: made[0]!.id,
      documentId,
      number: d.number,
      clientName: d.client_name,
      paidKobo: owed,
    };
  });
}

/**
 * The invoice a sender means by its number. Invoices and payment requests
 * share a sequence; quotes have their own, so "invoice 3" must not find
 * quote 3.
 */
export async function findPayableByNumber(
  userId: string,
  number: number,
): Promise<{ id: string; number: number; clientName: string; owedKobo: number; status: string } | null> {
  const { rows } = await db().query<{
    id: string;
    number: number;
    status: string;
    total_kobo: number;
    amount_paid_kobo: number;
    client_name: string;
  }>(
    `SELECT d.id, d.number, d.status, d.total_kobo, d.amount_paid_kobo, c.name AS client_name
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.number = $2 AND d.type IN ('invoice', 'payment_request')
        AND d.status <> 'draft'
      ORDER BY d.created_at DESC LIMIT 1`,
    [userId, number],
  );
  const r = rows[0];
  return r
    ? { id: r.id, number: r.number, clientName: r.client_name, owedKobo: r.total_kobo - r.amount_paid_kobo, status: r.status }
    : null;
}
