/**
 * "Invoice them again" (5 November 2026).
 *
 * Most of what a freelancer bills is the same client for the same work. The
 * last invoice, to everyone or to the client named, becomes a new draft dated
 * today: the same items and prices, the same client and contact details, the
 * same VAT, and a due date as far off as last time's was. It is a draft, so
 * it is read and changed like any other before anything is sent.
 */

import { db } from "../db/pool.ts";
import { b } from "../whatsapp/format.ts";
import type { Civil } from "../../core/dates.ts";
import type { PendingDoc } from "../conversation/machine.ts";

const addDays = (d: Civil, n: number): Civil => {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** A name as typed, safe inside ILIKE: its own % and _ are literal. */
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export type Again = { ok: true; doc: PendingDoc; number: number | null } | { ok: false; line: string };

export async function lastInvoiceAgain(userId: string, client: string | null, today: Civil): Promise<Again> {
  const named = client?.trim() || null;
  const { rows } = await db().query<{
    id: string;
    number: number | null;
    currency: string;
    subtotal_kobo: number;
    vat_kobo: number;
    term: number | null;
    title: string | null;
    pass_fees_to_client: boolean;
    name: string;
    email: string | null;
    phone: string | null;
  }>(
    `SELECT d.id, d.number, d.currency, d.subtotal_kobo, d.vat_kobo, d.title, d.pass_fees_to_client,
            (d.due_date - d.issue_date) AS term, c.name, c.email, c.phone
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.type = 'invoice' AND d.status <> 'draft'
        AND c.deleted_at IS NULL
        AND ($2::text IS NULL OR c.name ILIKE $3)
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [userId, named, named ? likeOf(named) : null],
  );
  const d = rows[0];
  if (!d) {
    return {
      ok: false,
      line: named
        ? `🤔 I couldn't find an earlier invoice for ${b(named)}. Type it as usual: ${b(`Invoice ${named} 150k for logo design, due Friday`)}.`
        : `🤔 There's no earlier invoice to copy yet. Type your first one: ${b("Invoice Tunde 150k for logo design, due Friday")}.`,
    };
  }
  if (d.currency !== "NGN") {
    return {
      ok: false,
      line: `That invoice to ${b(d.name)} was in ${d.currency}, and I can only copy naira invoices for now. Type it again and I'll draw it.`,
    };
  }

  const items = await db().query<{ description: string; qty: string; unit_amount_kobo: number }>(
    `SELECT description, qty::text, unit_amount_kobo FROM line_items WHERE document_id = $1 ORDER BY position`,
    [d.id],
  );
  if (!items.rows.length) return { ok: false, line: `🤔 That invoice to ${b(d.name)} has no items I can copy. Type it as usual.` };

  const vat = d.vat_kobo > 0 && d.subtotal_kobo > 0 ? Math.round((d.vat_kobo * 1000) / d.subtotal_kobo) / 10 : null;
  return {
    ok: true,
    number: d.number,
    doc: {
      type: "invoice",
      clientName: d.name,
      clientEmail: d.email,
      clientPhone: d.phone,
      lines: items.rows.map((l) => ({ description: l.description, qty: Number(l.qty), unitAmountKobo: Number(l.unit_amount_kobo) })),
      ...(d.term !== null && d.term > 0 ? { dueDate: addDays(today, d.term) } : { noDue: d.term === null }),
      vatPercent: vat,
      title: d.title,
      passFeesToClient: d.pass_fees_to_client,
    },
  };
}
