/**
 * Turning a stored document into a PDF (PRD F20).
 *
 * Renders from the database row, not from whatever the conversation was
 * holding, and keeps the snapshot it rendered from. F20: "Every version of an
 * edited document is kept", and a reissue must be byte-identical to what the
 * client already has.
 *
 * Nothing here throws. A PDF is the best part of the product and not the
 * necessary part — the link works without one — so a render failure degrades
 * to a link rather than losing the invoice.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import type { Civil } from "../../core/dates.ts";
import { renderPdf, rendererAvailable } from "../pdf/chrome.ts";
import { renderDocumentHtml, snapshotOf, type DocumentData, type Variant } from "../pdf/template.ts";
import { renderTemplate, TEMPLATES } from "../pdf/templates.ts";
import { documentKey, fileName, put, receiptKey } from "../storage/files.ts";
import { logoDataUri } from "../brand/user-logo.ts";

/** Section 12: both lines appear on everything a client sees. */
export function legalLines(): [string, string] {
  return [
    `Balans is a product of ${env.LEGAL_ENTITY_NAME}. Balans is not a bank and does not hold customer funds.`,
    "Payments are processed by Monnify and settle directly to the merchant's bank account.",
  ];
}

const civil = (d: Date | null): Civil | null =>
  d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null;

/* -------------------------------------------------------------------------- */

export type Rendered = { key: string; bytes: Buffer; filename: string };

/**
 * Renders a document and stores it.
 *
 * Returns null when it could not be produced, which the caller treats as "send
 * the link without a file" rather than as an error.
 */
export async function renderDocumentPdf(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<Rendered | null> {
  if (!rendererAvailable()) {
    log.warn({ documentId }, "no PDF renderer on this host; sending the link only");
    return null;
  }

  const data = await loadForRender(documentId);
  if (!data) {
    log.error({ documentId }, "nothing to render");
    return null;
  }

  const { doc, userId, version, templateId } = data;

  try {
    const started = Date.now();
    // The user's chosen layout, or the one the product shipped with. A
    // template that was withdrawn falls back rather than failing to render.
    const html = renderTemplate(templateId, doc) ?? renderDocumentHtml(doc);
    const bytes = await renderPdf(html);
    const key = documentKey(documentId, version);

    await put(key, bytes, "application/pdf", userId);
    await recordVersion(documentId, version, doc, key);

    log.info({ documentId, version, bytes: bytes.length, ms: Date.now() - started }, "pdf rendered");

    return {
      key,
      bytes,
      filename: fileName(labelFor(doc.variant), doc.number, doc.clientName),
    };
  } catch (err) {
    // The invoice exists, is numbered and is payable. A missing PDF is a
    // worse-looking message, not a lost document.
    log.error({ err, documentId }, "could not render the pdf");
    return null;
  }
}

/** F11: a receipt, rendered from the payment that settled the document. */
export async function renderReceiptPdf(
  paymentId: string,
  log: FastifyBaseLogger,
): Promise<Rendered | null> {
  if (!rendererAvailable()) return null;

  const { rows } = await db().query<{
    document_id: string;
    reference: string;
    channel: string | null;
    paid_at: Date | null;
    client_total_kobo: number;
  }>(
    `SELECT document_id, reference, channel, paid_at, client_total_kobo
       FROM payments WHERE id = $1`,
    [paymentId],
  );
  const p = rows[0];
  if (!p) return null;

  const data = await loadForRender(p.document_id);
  if (!data) return null;

  const number = await nextReceiptNumber(data.userId);

  const doc: DocumentData = {
    ...data.doc,
    variant: "receipt",
    amountPaidKobo: p.client_total_kobo,
    receipt: {
      number,
      paidOn: civil(p.paid_at) ?? data.doc.issueDate ?? { y: 1970, m: 1, d: 1 },
      method: p.channel,
      reference: p.reference,
    },
  };

  try {
    const bytes = await renderPdf(renderDocumentHtml(doc));
    const key = receiptKey(paymentId);
    await put(key, bytes, "application/pdf", data.userId);

    await db().query(
      `INSERT INTO receipts (payment_id, number, pdf_key) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [paymentId, number, key],
    );

    log.info({ paymentId, number, bytes: bytes.length }, "receipt rendered");
    return { key, bytes, filename: fileName("Receipt", number, doc.clientName) };
  } catch (err) {
    log.error({ err, paymentId }, "could not render the receipt");
    return null;
  }
}

/* -------------------------------------------------------------------------- */

const labelFor = (v: Variant): string =>
  v === "quote" ? "Quote" : v === "receipt" ? "Receipt" : "Invoice";

/** Everything the template needs, in one query per document. */
async function loadForRender(
  documentId: string,
): Promise<{ doc: DocumentData; userId: string; version: number; templateId: string | null } | null> {
  const { rows } = await db().query<{
    user_id: string;
    type: string;
    number: number | null;
    ref: string | null;
    subtotal_kobo: number;
    vat_kobo: number;
    total_kobo: number;
    amount_paid_kobo: number;
    issue_date: Date | null;
    due_date: Date | null;
    valid_until: Date | null;
    notes: string | null;
    public_token: string | null;
    current_version: number;
    business_name: string | null;
    business_email: string | null;
    address: string | null;
    tin: string | null;
    logo_url: string | null;
    plan: "free" | "pro";
    template_id: string | null;
    client_name: string;
    client_email: string | null;
  }>(
    `SELECT d.user_id, d.type, d.number, d.ref, d.subtotal_kobo, d.vat_kobo, d.total_kobo,
            d.amount_paid_kobo, d.issue_date, d.due_date, d.valid_until, d.notes,
            d.public_token, d.current_version,
            u.business_name, u.email AS business_email, u.address, u.tin, u.logo_url,
            u.plan, u.template_id,
            c.name AS client_name, c.email AS client_email
       FROM documents d
       JOIN users u   ON u.id = d.user_id
       JOIN clients c ON c.id = d.client_id
      WHERE d.id = $1`,
    [documentId],
  );

  const r = rows[0];
  if (!r) return null;

  const { rows: items } = await db().query<{
    description: string;
    qty: string;
    unit_amount_kobo: number;
    amount_kobo: number;
  }>(
    `SELECT description, qty, unit_amount_kobo, amount_kobo
       FROM line_items WHERE document_id = $1 ORDER BY position`,
    [documentId],
  );

  const variant: Variant =
    r.type === "quote" ? "quote" : r.type === "sample" ? "sample" : "invoice";

  return {
    userId: r.user_id,
    version: r.current_version,
    // A Pro layout stops applying the moment a subscription lapses, so a Free
    // invoice never goes out carrying a paid design.
    templateId: r.plan === "pro" || !isProTemplate(r.template_id) ? r.template_id : null,
    doc: {
      variant,
      number: r.number,
      ref: r.ref,
      businessName: r.business_name ?? "A Balans user",
      businessEmail: r.business_email,
      businessAddress: r.address,
      businessTin: r.tin,
      // F21: Pro only, and read from storage rather than linked, because a
      // render must never fetch anything.
      logoDataUri: await logoDataUri(r.user_id, r.plan, r.logo_url),
      clientName: r.client_name,
      clientEmail: r.client_email,
      lines: items.map((i) => ({
        description: i.description,
        qty: Number(i.qty),
        unitAmountKobo: i.unit_amount_kobo,
        amountKobo: i.amount_kobo,
      })),
      subtotalKobo: r.subtotal_kobo,
      vatKobo: r.vat_kobo,
      vatPercent: r.vat_kobo > 0 ? round1((r.vat_kobo / r.subtotal_kobo) * 100) : null,
      totalKobo: r.total_kobo,
      amountPaidKobo: r.amount_paid_kobo,
      issueDate: civil(r.issue_date),
      dueDate: civil(r.due_date ?? r.valid_until),
      notes: r.notes,
      publicUrl: r.public_token
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${r.public_token}`
        : null,
      legalLines: legalLines(),
      // F9: the Free plan carries the line. Pro does not.
      showMadeWith: r.plan !== "pro",
    },
  };
}

/** F20: keep what each version was rendered from, so a reissue matches. */
async function recordVersion(
  documentId: string,
  version: number,
  doc: DocumentData,
  key: string,
): Promise<void> {
  await db().query(
    `INSERT INTO document_versions (document_id, version, snapshot_json, pdf_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (document_id, version) DO UPDATE SET pdf_key = EXCLUDED.pdf_key`,
    [documentId, version, JSON.stringify(snapshotOf(doc)), key],
  );
}

/**
 * Receipt numbers run per user, like document numbers.
 *
 * A freelancer's receipts should read 1, 2, 3, not carry a global id that
 * tells their client how many customers Balans has.
 */
async function nextReceiptNumber(userId: string): Promise<number> {
  const { rows } = await db().query<{ next: number }>(
    `SELECT COALESCE(MAX(r.number), 0) + 1 AS next
       FROM receipts r
       JOIN payments p  ON p.id = r.payment_id
       JOIN documents d ON d.id = p.document_id
      WHERE d.user_id = $1`,
    [userId],
  );
  return rows[0]?.next ?? 1;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const isProTemplate = (id: string | null): boolean =>
  TEMPLATES.some((t) => t.id === id && t.pro);
