/**
 * Sending a document to the client's WhatsApp, from the Balans number.
 *
 * Until now a client only saw an invoice if the freelancer forwarded it, and
 * the forward is the step that gets forgotten. With a number on the client,
 * the invoice arrives on its own the moment it is sent — and it arrives from
 * Balans, which is how a client who bills people too finds out it exists.
 *
 * Pro only, since 26 September 2026: the email copy is free on every plan,
 * and this is what Pro adds on top. The form shows the phone box to Free
 * users greyed out, saying so (see `phone_help` in definitions.ts), and this
 * checks the plan again because a number can also be typed into the chat.
 *
 * It has to be a template. The client has never written to us, so there is
 * no 24-hour window, and anything but an approved template is refused. Until
 * Meta approves `client_invoice` and `client_quote` (`npm run templates --
 * --submit`), this fails and says so, and the freelancer is told to forward
 * it instead — the invoice itself went out regardless.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { formatMoney, type Currency } from "../../core/currency.ts";
import { agreedTotalMinor } from "../../core/exchange.ts";
import { sendTemplate } from "../whatsapp/client.ts";
import { planOf } from "./queries.ts";
import { TEMPLATES, TEMPLATE_LANGUAGE } from "../whatsapp/window.ts";
import { renderReceiptPdf } from "./pdf.ts";
import { env } from "../config.ts";

/** Whether Meta has approved a template, as last recorded (register-templates.ts). */
async function templateApproved(name: string): Promise<boolean> {
  const { rows } = await db()
    .query<{ s: string | null }>(`SELECT value_json ->> $1 AS s FROM config WHERE key = 'template_status'`, [name])
    .catch(() => ({ rows: [] as { s: string | null }[] }));
  return rows[0]?.s === "APPROVED";
}

export type WhatsAppDelivery =
  | { ok: true; to: string }
  | { ok: false; why: "no_client_phone" | "not_found" | "not_pro" | "send_failed"; to?: string };

/** "Tunde" out of "Tunde Olamide": a greeting, not a form of address. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name.trim();

/**
 * What the client is told they owe, in what they agreed to pay in.
 *
 * Dollars on a dollar invoice, with its VAT: the client abroad said yes to
 * "$650", and a message about "₦932,000" reads as somebody else's bill.
 */
export function amountFor(d: {
  total_kobo: number;
  subtotal_kobo: number;
  vat_kobo: number;
  currency: string;
  original_amount_minor: number | null;
}): string {
  if (d.currency !== "NGN" && d.original_amount_minor !== null) {
    return formatMoney(
      agreedTotalMinor(d.original_amount_minor, d.subtotal_kobo, d.vat_kobo),
      d.currency as Currency,
    );
  }
  return formatNaira(d.total_kobo);
}

/** The template and its words, for one document. Pure, so it can be tested. */
export function clientMessage(d: {
  type: string;
  number: number | string | null;
  client_name: string;
  business_name: string | null;
  amount: string;
}): { template: string; params: string[] } {
  const business = d.business_name ?? "A Balans user";
  const who = firstName(d.client_name);

  if (d.type === "quote") {
    return {
      template: TEMPLATES.client_quote.name,
      params: [who, business, d.amount, d.number === null ? "Quote" : `Quote ${d.number}`],
    };
  }
  const what =
    d.type === "payment_request"
      ? "a payment request"
      : d.number === null
        ? "an invoice"
        : `Invoice ${d.number}`;
  return { template: TEMPLATES.client_invoice.name, params: [who, business, what, d.amount] };
}

export async function whatsappDocumentToClient(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<WhatsAppDelivery> {
  const { rows } = await db().query<{
    user_id: string;
    type: string;
    number: string | null;
    total_kobo: number;
    subtotal_kobo: number;
    vat_kobo: number;
    currency: string;
    original_amount_minor: number | null;
    public_token: string | null;
    client_name: string;
    client_phone: string | null;
    business_name: string | null;
  }>(
    `SELECT d.user_id, d.type, COALESCE(LPAD(d.number::text, GREATEST(4, length(d.number::text)), '0'), substring(d.ref from 4)) AS number, d.total_kobo, d.subtotal_kobo, d.vat_kobo, d.currency,
            d.original_amount_minor, d.public_token,
            c.name AS client_name, c.phone AS client_phone, u.business_name
       FROM documents d
       JOIN clients c ON c.id = d.client_id
       JOIN users u   ON u.id = d.user_id
      WHERE d.id = $1 AND d.status <> 'draft'`,
    [documentId],
  );

  const d = rows[0];
  if (!d || !d.public_token) return { ok: false, why: "not_found" };
  if (!d.client_phone) return { ok: false, why: "no_client_phone" };
  if ((await planOf(d.user_id)) !== "pro") return { ok: false, why: "not_pro" };

  const plain = clientMessage({ ...d, amount: amountFor(d) });
  /*
   * With the PDF attached when Meta has approved that version (7 October
   * 2026); the plain one, with only the link, until then. Meta fetches the
   * PDF from our own public link for this document.
   */
  const pdfName = d.type === "quote" ? TEMPLATES.client_quote_pdf.name : TEMPLATES.client_invoice_pdf.name;
  const withPdf = await templateApproved(pdfName);
  const template = withPdf ? pdfName : plain.template;
  const label = d.type === "quote" ? "Quote" : d.type === "payment_request" ? "Payment request" : "Invoice";
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const sent = await sendTemplate(d.client_phone, template, plain.params, {
    language: TEMPLATE_LANGUAGE,
    urlSuffix: d.public_token,
    ...(withPdf
      ? {
          headerDocument: {
            link: `${base}/${d.type === "quote" ? "q" : "i"}/${d.public_token}/pdf`,
            filename: `${label}${d.number ? ` ${d.number}` : ""} - ${(d.business_name ?? "Balans").replace(/[\\/:*?"<>|]/g, "")}.pdf`,
          },
        }
      : {}),
  });

  if (!sent.ok) {
    log.error({ documentId, template, reason: sent.reason }, "could not send the document to the client's WhatsApp");
    return { ok: false, why: "send_failed", to: d.client_phone };
  }
  log.info({ documentId, template }, "document sent to the client's WhatsApp");
  return { ok: true, to: d.client_phone };
}

/**
 * The due-date reminder, to the client's WhatsApp.
 *
 * Pro, like the invoice itself on this channel, and only for an invoice with
 * something still owed. It uses `client_reminder`, which Meta has to approve
 * before it will send; until then this fails, says so, and the reminder
 * still goes by email if there is an address.
 */
export async function whatsappReminderToClient(
  documentId: string,
  due: string,
  log: FastifyBaseLogger,
): Promise<WhatsAppDelivery> {
  const { rows } = await db().query<{
    user_id: string;
    total_kobo: number;
    amount_paid_kobo: number;
    subtotal_kobo: number;
    vat_kobo: number;
    currency: string;
    original_amount_minor: number | null;
    public_token: string | null;
    client_name: string;
    client_phone: string | null;
    business_name: string | null;
  }>(
    `SELECT d.user_id, d.total_kobo, d.amount_paid_kobo, d.subtotal_kobo, d.vat_kobo, d.currency,
            d.original_amount_minor, d.public_token,
            c.name AS client_name, c.phone AS client_phone, u.business_name
       FROM documents d
       JOIN clients c ON c.id = d.client_id
       JOIN users u   ON u.id = d.user_id
      WHERE d.id = $1 AND d.type = 'invoice'`,
    [documentId],
  );

  const d = rows[0];
  if (!d || !d.public_token || d.total_kobo <= d.amount_paid_kobo) return { ok: false, why: "not_found" };
  if (!d.client_phone) return { ok: false, why: "no_client_phone" };
  if ((await planOf(d.user_id)) !== "pro") return { ok: false, why: "not_pro" };

  // Nothing paid on a dollar invoice: still owed in dollars. Part paid, the
  // rest is only known in naira, which is what was charged.
  const owed =
    d.currency !== "NGN" && d.amount_paid_kobo === 0 ? amountFor(d) : formatNaira(d.total_kobo - d.amount_paid_kobo);

  const sent = await sendTemplate(
    d.client_phone,
    "client_reminder",
    [firstName(d.client_name), d.business_name ?? "A Balans user", owed, due],
    { language: TEMPLATE_LANGUAGE, urlSuffix: d.public_token },
  );

  if (!sent.ok) {
    log.error({ documentId, reason: sent.reason }, "could not send the reminder to the client's WhatsApp");
    return { ok: false, why: "send_failed", to: d.client_phone };
  }
  log.info({ documentId }, "reminder sent to the client's WhatsApp");
  return { ok: true, to: d.client_phone };
}

/**
 * The receipt, to the client's WhatsApp, as a PDF (7 October 2026). Only for
 * a client with a number and no email — `deliverPaidToClient` decides — and
 * only once Meta has approved `client_paid`.
 *
 * The receipt PDF is rendered first so its public link has a file behind it;
 * if it cannot be, the invoice itself goes, which is stamped PAID.
 */
export async function whatsappPaidToClient(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<{ ok: true; to: string } | { ok: false; why: "no_client_phone" | "not_approved" | "not_found" | "send_failed" }> {
  const { rows } = await db().query<{
    type: string;
    number: string | null;
    total_kobo: number;
    subtotal_kobo: number;
    vat_kobo: number;
    currency: string;
    original_amount_minor: number | null;
    public_token: string | null;
    client_name: string;
    client_phone: string | null;
    business_name: string | null;
  }>(
    `SELECT d.type, COALESCE(LPAD(d.number::text, GREATEST(4, length(d.number::text)), '0'), substring(d.ref from 4)) AS number,
            d.total_kobo, d.subtotal_kobo, d.vat_kobo, d.currency, d.original_amount_minor, d.public_token,
            c.name AS client_name, c.phone AS client_phone, u.business_name
       FROM documents d JOIN clients c ON c.id = d.client_id JOIN users u ON u.id = d.user_id
      WHERE d.id = $1`,
    [documentId],
  );
  const d = rows[0];
  if (!d?.public_token) return { ok: false, why: "not_found" };
  if (!d.client_phone) return { ok: false, why: "no_client_phone" };
  if (!(await templateApproved(TEMPLATES.client_paid.name))) {
    log.info({ documentId }, "client receipt by WhatsApp waits for client_paid to be approved");
    return { ok: false, why: "not_approved" };
  }

  // A file behind the receipt link, or the stamped invoice instead.
  const { rows: pay } = await db().query<{ id: string }>(
    `SELECT id FROM payments WHERE document_id = $1 AND status = 'success' ORDER BY created_at DESC LIMIT 1`,
    [documentId],
  );
  const receipt = pay[0] ? await renderReceiptPdf(pay[0].id, log).catch(() => null) : null;
  const { rows: stored } = await db().query<{ k: string | null }>(
    `SELECT r.pdf_key AS k FROM receipts r JOIN payments p ON p.id = r.payment_id
      WHERE p.document_id = $1 AND p.status = 'success' ORDER BY r.created_at DESC LIMIT 1`,
    [documentId],
  );
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const hasReceipt = Boolean(receipt && stored[0]?.k);
  const label = d.type === "payment_request" ? "Payment request" : "Invoice";
  const business = d.business_name ?? "A Balans user";

  const sent = await sendTemplate(
    d.client_phone,
    TEMPLATES.client_paid.name,
    [firstName(d.client_name), business, amountFor(d), `${label}${d.number ? ` ${d.number}` : ""}`],
    {
      language: TEMPLATE_LANGUAGE,
      headerDocument: {
        link: `${base}/i/${d.public_token}/${hasReceipt ? "receipt" : "pdf"}`,
        filename: `${hasReceipt ? "Receipt" : label}${d.number ? ` ${d.number}` : ""} - ${business.replace(/[\\/:*?"<>|]/g, "")}.pdf`,
      },
    },
  );
  if (!sent.ok) {
    log.error({ documentId, reason: sent.reason }, "could not send the receipt to the client's WhatsApp");
    return { ok: false, why: "send_failed" };
  }
  log.info({ documentId, withReceipt: hasReceipt }, "receipt sent to the client's WhatsApp");
  return { ok: true, to: d.client_phone };
}
