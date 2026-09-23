/**
 * The two emails a payment sends.
 *
 * A payment is the only moment in this product where both sides want a record
 * at the same time and for different reasons:
 *
 *   - The client wants proof. Their accounts department will ask for it in
 *     March, and "I paid it on WhatsApp" is not proof. They get the invoice
 *     with PAID across it and the receipt beside it, so the two documents
 *     answer "what was this for" and "when was it settled" without anybody
 *     going looking.
 *   - The freelancer wants the moment. They already have it on WhatsApp,
 *     which is where they live; the email is the copy that survives a phone
 *     being lost and is searchable next year at tax time.
 *
 * Both are best-effort and neither throws. The payment is already recorded and
 * the money is already moving; an email provider having a bad afternoon must
 * cost a copy of the paperwork, never the payment.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { sendEmail } from "./send.ts";
import { amount, layout, paragraph, button, type InlineImage } from "./layout.ts";
import { renderDocumentPdf, renderReceiptPdf } from "../documents/pdf.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The picture at the top. Drawn in assets/email/paid-banner.html.
 *
 * Attached rather than linked, like every other banner here: mail clients
 * block remote images by default, and a payment confirmation that arrives as
 * a grey box with a broken-image icon is the wrong first impression of the
 * one message this product exists to send.
 *
 * The column is 600 wide with 32px either side; the file is twice this.
 */
const PAID_BANNER: InlineImage = {
  cid: "paid-banner",
  file: "paid-banner.png",
  alt: "Payment received. Dem don balans you.",
  width: 536,
  height: 214,
};

type Row = {
  user_id: string;
  number: number | null;
  ref: string | null;
  type: string;
  total_kobo: number;
  paid_at: Date | null;
  public_token: string | null;
  client_name: string;
  client_email: string | null;
  business_name: string | null;
  business_email: string | null;
};

const civil = (d: Date): Civil => ({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });

async function paidRow(documentId: string): Promise<Row | null> {
  const { rows } = await db().query<Row>(
    `SELECT d.user_id, d.number, d.ref, d.type, d.total_kobo, d.paid_at, d.public_token,
            c.name AS client_name, c.email AS client_email,
            u.business_name, u.email AS business_email
       FROM documents d
       JOIN clients c ON c.id = d.client_id
       JOIN users u   ON u.id = d.user_id
      WHERE d.id = $1`,
    [documentId],
  );
  return rows[0] ?? null;
}

/**
 * The client's copy: the invoice, stamped, and the receipt.
 *
 * Not gated on Pro, deliberately, where the invoice delivery itself is (F21).
 * Pro decides whether we email somebody's invoices for them, which is a
 * feature of their business. This is a receipt for money that has already
 * changed hands, and a client who paid is owed proof whatever plan the person
 * they paid happens to be on.
 */
export async function emailPaidToClient(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<{ ok: boolean }> {
  try {
    const d = await paidRow(documentId);
    if (!d) return { ok: false };
    // Nothing to send to nobody. Most clients pay without ever giving one.
    if (!d.client_email) return { ok: false };

    const business = d.business_name ?? "A Balans user";
    const label = d.number === null ? "Invoice" : `Invoice #${d.number}`;
    const link = d.public_token
      ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${d.public_token}`
      : null;
    const when = d.paid_at ? civil(d.paid_at) : null;

    /*
     * Both documents, because they are not the same document.
     *
     * The invoice says what the money was for, line by line, and now carries
     * PAID across it. The receipt says the payment happened and when. An
     * accounts department asks for one or the other depending on the
     * question, and neither of them wants to email anybody to get it.
     */
    const [invoice, receipt] = await Promise.all([
      renderDocumentPdf(documentId, log),
      receiptForDocument(documentId, log),
    ]);

    const body = [
      paragraph(`${esc(d.client_name)},`),
      paragraph(`Your payment to ${esc(business)} has gone through. Thank you.`),
      amount("Paid", formatNaira(d.total_kobo), when ? formatFriendly(when) : undefined),
      link ? button("View the invoice", link) : "",
      d.ref ? paragraph(`Reference ${esc(d.ref)}`, true) : "",
      paragraph(
        receipt
          ? "Your receipt and the paid invoice are attached, for your records."
          : "The paid invoice is attached, for your records.",
        true,
      ),
    ]
      .filter(Boolean)
      .join("\n");

    const attachments = [
      ...(invoice ? [{ filename: invoice.filename, content: invoice.bytes }] : []),
      ...(receipt ? [{ filename: receipt.filename, content: receipt.bytes }] : []),
    ];

    const sent = await sendEmail(
      {
        to: d.client_email,
        // The business they paid, not us. A receipt from a company the client
        // has never heard of is a receipt they query.
        fromName: `${business} via Balans`,
        replyTo: d.business_email ?? undefined,
        subject: `Paid — ${label} from ${business}, ${formatNaira(d.total_kobo)}`,
        html: layout({
          preheader: `${formatNaira(d.total_kobo)} received${when ? ` on ${formatFriendly(when)}` : ""}.`,
          eyebrow: business,
          heading: "Payment received",
          banner: PAID_BANNER,
          body,
        }),
        images: [PAID_BANNER],
        text: [
          `${d.client_name},`,
          "",
          `Your payment of ${formatNaira(d.total_kobo)} to ${business} has gone through${
            when ? ` on ${formatFriendly(when)}` : ""
          }. Thank you.`,
          "",
          link ? `View the invoice: ${link}` : "",
          d.ref ? `Reference: ${d.ref}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        attachments: attachments.length ? attachments : undefined,
      },
      log,
    );

    if (!sent.ok) {
      log.error({ documentId, reason: sent.reason }, "could not email the receipt to the client");
      return { ok: false };
    }

    log.info(
      { documentId, attached: attachments.length },
      "paid invoice and receipt emailed to client",
    );
    return { ok: true };
  } catch (e) {
    // Never throws. The money has already moved.
    log.error({ err: (e as Error).message, documentId }, "paid client email failed");
    return { ok: false };
  }
}

/**
 * The freelancer's own copy, with the poster.
 *
 * They already know — WhatsApp told them seconds ago, with the same picture.
 * This is the copy that survives a lost phone and is searchable at tax time,
 * which is the one moment in the year anybody goes looking for it.
 */
export async function emailPaidToUser(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<{ ok: boolean }> {
  try {
    const d = await paidRow(documentId);
    if (!d?.business_email) return { ok: false };

    const label = d.number === null ? "your invoice" : `invoice #${d.number}`;
    const when = d.paid_at ? civil(d.paid_at) : null;
    const link = d.public_token
      ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${d.public_token}`
      : null;

    const [invoice, receipt] = await Promise.all([
      renderDocumentPdf(documentId, log),
      receiptForDocument(documentId, log),
    ]);

    const body = [
      paragraph(`${esc(d.client_name)} has paid ${esc(label)}.`),
      amount("Paid to you", formatNaira(d.total_kobo), when ? formatFriendly(when) : undefined),
      link ? button("See the invoice", link) : "",
      d.ref ? paragraph(`Reference ${esc(d.ref)}`, true) : "",
      paragraph(
        receipt
          ? "The paid invoice and the receipt are attached. Your client has been sent the same."
          : "The paid invoice is attached. Your client has been sent the same.",
        true,
      ),
    ]
      .filter(Boolean)
      .join("\n");

    const attachments = [
      ...(invoice ? [{ filename: invoice.filename, content: invoice.bytes }] : []),
      ...(receipt ? [{ filename: receipt.filename, content: receipt.bytes }] : []),
    ];

    const sent = await sendEmail(
      {
        to: d.business_email,
        subject: `Dem don balans you — ${formatNaira(d.total_kobo)} from ${d.client_name}`,
        html: layout({
          preheader: `${d.client_name} paid ${formatNaira(d.total_kobo)}.`,
          eyebrow: "Payment received",
          heading: "Dem don balans you",
          // The same picture on both copies. The poster carries the phrase,
          // so the heading does not have to shout it twice.
          banner: PAID_BANNER,
          body,
        }),
        images: [PAID_BANNER],
        text: [
          `${d.client_name} has paid ${label}: ${formatNaira(d.total_kobo)}${
            when ? ` on ${formatFriendly(when)}` : ""
          }.`,
          "",
          link ? `See the invoice: ${link}` : "",
          d.ref ? `Reference: ${d.ref}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        attachments: attachments.length ? attachments : undefined,
      },
      log,
    );

    if (!sent.ok) {
      log.error({ documentId, reason: sent.reason }, "could not email the payment to the user");
      return { ok: false };
    }

    log.info({ documentId }, "payment emailed to user");
    return { ok: true };
  } catch (e) {
    log.error({ err: (e as Error).message, documentId }, "paid user email failed");
    return { ok: false };
  }
}

/**
 * The receipt for the payment that settled this document, if there is one.
 *
 * Null rather than an error when there is no successful payment on file: a
 * document can be marked paid by hand, and an email that says a receipt is
 * attached when none is sends somebody looking for a file that does not exist.
 */
async function receiptForDocument(
  documentId: string,
  log: FastifyBaseLogger,
): Promise<{ bytes: Buffer; filename: string } | null> {
  const { rows } = await db().query<{ id: string }>(
    `SELECT id FROM payments
      WHERE document_id = $1 AND status = 'success'
      ORDER BY created_at DESC
      LIMIT 1`,
    [documentId],
  );
  const paymentId = rows[0]?.id;
  return paymentId ? renderReceiptPdf(paymentId, log) : null;
}
