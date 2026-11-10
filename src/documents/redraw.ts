/**
 * A sent invoice, drawn again in the design the sender has now (9 November 2026).
 *
 * People change design right after their first invoice, because that is when
 * they first see one, and then ask for that invoice "with my chosen design".
 * Only the look changes: the number, the amounts, the client, the due date and
 * the link stay exactly as sent. The new PDF replaces the stored one, so the
 * client's link has it too, and the sender gets it to check or forward.
 * Nothing goes to the client by itself.
 *
 * Unpaid only: a paid invoice has a receipt that matches what was paid. A
 * payment request has no PDF. A Pro design on Free falls back as it does for
 * every PDF (pdf.ts loadForRender).
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { b, para } from "../whatsapp/format.ts";
import { send } from "../whatsapp/outbound.ts";
import { TEMPLATES } from "../pdf/templates.ts";

export type Redrawable =
  | { ok: true; id: string; number: number; type: string; clientName: string }
  | { ok: false; line: string };

export async function findRedrawable(userId: string, number: number | null): Promise<Redrawable> {
  const { rows } = await db().query<{
    id: string;
    number: number | null;
    type: string;
    status: string;
    total_kobo: number;
    amount_paid_kobo: number;
    client_name: string;
  }>(
    `SELECT d.id, d.number, d.type, d.status, d.total_kobo, d.amount_paid_kobo, c.name AS client_name
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.status <> 'draft' AND d.type <> 'sample'
        AND ($2::int IS NULL OR d.number = $2)
        AND ($2::int IS NOT NULL OR (d.type IN ('invoice', 'quote')
             AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid') AND d.total_kobo > d.amount_paid_kobo))
      ORDER BY d.created_at DESC LIMIT 1`,
    [userId, number],
  );
  const d = rows[0];
  if (!d || d.number === null) {
    return {
      ok: false,
      line: number === null ? "🔍 There's no unpaid invoice to redraw." : `🔍 I can't find ${b(`invoice #${number}`)}.`,
    };
  }
  if (d.type === "payment_request") return { ok: false, line: `A payment request has no PDF to redraw, only its link.` };
  if (d.status === "cancelled") return { ok: false, line: `Invoice #${d.number} was cancelled, so there's nothing to redraw.` };
  if (d.status === "paid" || d.total_kobo <= d.amount_paid_kobo) {
    return { ok: false, line: `Invoice #${d.number} is paid, so it keeps the design its receipt matches. New invoices use your new design.` };
  }
  return { ok: true, id: d.id, number: d.number, type: d.type, clientName: d.client_name };
}

export function redrawCaption(d: { number: number; type: string; clientName: string }): string {
  const label = d.type === "quote" ? "Quote" : "Invoice";
  return para(
    `🎨 ${b(`${label} #${d.number}, in your current design.`)}`,
    `Same number, amounts and link. ${d.clientName}'s link shows this one now. Forward it if you want them to have the new look.`,
  );
}

/**
 * After a new design is saved on the designs page: if an unpaid invoice went
 * out in the old one, offer to redraw it. Inside the 24-hour window only (they
 * have just come from the chat); never a template, so it never costs a send
 * outside it.
 */
export async function offerRedraw(userId: string, templateId: string, log: FastifyBaseLogger): Promise<boolean> {
  try {
    const { rows } = await db().query<{ wa_phone: string; number: number; client_name: string }>(
      `SELECT u.wa_phone, d.number, c.name AS client_name
         FROM users u
         JOIN documents d ON d.user_id = u.id
         JOIN clients c ON c.id = d.client_id
        WHERE u.id = $1 AND d.type IN ('invoice', 'quote') AND d.number IS NOT NULL
          AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid') AND d.total_kobo > d.amount_paid_kobo
        ORDER BY d.created_at DESC LIMIT 1`,
      [userId],
    );
    const r = rows[0];
    if (!r) return false;
    const name = TEMPLATES.find((t) => t.id === templateId)?.name ?? "your new design";
    const out = await send(
      {
        userId,
        phone: r.wa_phone,
        text: para(
          `🎨 ${b(`Saved: new invoices use ${name}.`)}`,
          `Invoice #${r.number} to ${r.client_name} went out in your old design. Want it redrawn in ${name}? Same number and amount.`,
        ),
        buttons: [{ id: `redraw invoice ${r.number}`, title: `Redraw #${r.number}` }],
      },
      log,
    );
    return out.kind === "sent";
  } catch (err) {
    log.warn({ err, userId }, "could not offer a redraw");
    return false;
  }
}
