/**
 * Sending the invoice to the client (PRD F21).
 *
 * Until now an invoice only reached a client if the user forwarded it on
 * WhatsApp, which works and is how most of them will do it. But a client who
 * needs to put an invoice through accounts needs it in their inbox, with the
 * PDF attached, from a name their finance person recognises.
 *
 * Two details that matter more than they look:
 *
 *   - The from-name is the *user's* business, "via Balans". The client hired
 *     them, not us, and an invoice arriving from a company the client has
 *     never heard of is an invoice that gets queried.
 *   - Reply-to is the user's own email, so a client asking a question reaches
 *     the person who can answer it rather than our support inbox.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { sendEmail } from "./send.ts";
import { amount, layout, paragraph, button } from "./layout.ts";
import { renderDocumentPdf } from "../documents/pdf.ts";
import { documentLink } from "../documents/links.ts";
import { icsFor, type DueEvent } from "../documents/calendar.ts";

export type DeliveryResult =
  | { ok: true }
  | { ok: false; why: "no_client_email" | "not_pro" | "send_failed" | "not_found" };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The last line of the email — where to find it, and whether a file came with it.
 *
 * Its own function because it is the one sentence in here that can lie. A
 * payment request carries no attachment (F8: "a lightweight payable with no
 * PDF"), and an email that says one is attached when none is sends the client
 * looking for a file that does not exist, then asking the user about it.
 *
 * Exported so the rule can be tested by asking it rather than by reading the
 * source around it.
 */
export function closingLine(type: string, label: string, link: string | null): string {
  const where = esc(link ?? "the link above");
  return type === "payment_request"
    ? `You can always see it at ${where}.`
    : `The ${label.toLowerCase()} is attached, and you can always see it at ${where}.`;
}

/**
 * The due date as a calendar invitation, attached (invoices only).
 *
 * Attached rather than linked: an invitation is what Gmail, Apple Mail and
 * Outlook read to show an event card at the top of the email, with the date
 * and "Add to calendar" on it. Two links under the Pay button asked the
 * client to notice a line of text and leave for a website.
 *
 * From the business, to the client: that pairing is what makes it an
 * invitation to their calendar rather than a stray file. Null when there is
 * no due date or nothing to address it to.
 */
export function dueInvite(
  e: DueEvent,
  from: { name: string; email: string | null },
  to: { name: string; email: string },
  now = new Date(),
): { filename: string; content: Buffer; contentType: string } | null {
  if (!from.email) return null;
  return {
    filename: "invite.ics",
    content: Buffer.from(
      icsFor(e, now, { organizer: { name: from.name, email: from.email }, attendee: to }),
      "utf8",
    ),
    contentType: "text/calendar; charset=utf-8; method=REQUEST",
  };
}

/**
 * Emails a document to the client it is for.
 *
 * Client delivery is a Pro feature (F21). A Free user's invoice still has a
 * link and a PDF in WhatsApp — this adds the inbox, not the invoice.
 */
export async function emailDocumentToClient(
  documentId: string,
  log: FastifyBaseLogger,
  opts: { requirePro?: boolean } = { requirePro: true },
): Promise<DeliveryResult> {
  const { rows } = await db().query<{
    user_id: string;
    number: number | null;
    type: string;
    total_kobo: number;
    due_date: Date | null;
    valid_until: Date | null;
    public_token: string | null;
    notes: string | null;
    client_name: string;
    client_email: string | null;
    business_name: string | null;
    business_email: string | null;
    plan: "free" | "pro";
  }>(
    `SELECT d.user_id, d.number, d.type, d.total_kobo, d.due_date, d.valid_until,
            d.public_token, d.notes,
            c.name AS client_name, c.email AS client_email,
            u.business_name, u.email AS business_email, u.plan
       FROM documents d
       JOIN clients c ON c.id = d.client_id
       JOIN users u   ON u.id = d.user_id
      WHERE d.id = $1 AND d.status <> 'draft'`,
    [documentId],
  );

  const d = rows[0];
  if (!d) return { ok: false, why: "not_found" };
  if (!d.client_email) return { ok: false, why: "no_client_email" };
  if (opts.requirePro !== false && d.plan !== "pro") return { ok: false, why: "not_pro" };

  const label = d.type === "quote" ? "Quote" : "Invoice";
  const business = d.business_name ?? "A Balans user";
  const link = d.public_token
    ? documentLink(d.type, d.public_token)
    : null;

  const date = d.due_date ?? d.valid_until;
  const when: Civil | null = date
    ? { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
    : null;
  const dateWord = d.type === "quote" ? "Valid until" : "Due";

  /* The amount is what the message is about, so it is stated once and set
     large, the way the invoice itself states it — not buried in a sentence
     the reader has to re-read to find it. */
  const body = [
    paragraph(`${esc(d.client_name)},`),
    paragraph(`${esc(business)} has sent you ${label.toLowerCase()}.`),
    amount(
      d.type === "quote" ? "Quoted" : "Amount due",
      formatNaira(d.total_kobo),
      when ? `${dateWord} ${formatFriendly(when)}` : undefined,
    ),
    d.notes ? paragraph(esc(d.notes), true) : "",
    link && d.type !== "quote" ? button(`Pay ${formatNaira(d.total_kobo)}`, link) : "",
    link && d.type === "quote" ? button("View quote", link) : "",
    paragraph(closingLine(d.type, label, link), true),
  ]
    .filter(Boolean)
    .join("\n");

  // Nothing to attach for a payment request, and the body must not promise
  // one either — see the line about it being attached, below.
  const pdf =
    d.type === "payment_request" ? null : await renderDocumentPdf(documentId, log);

  // The due date, for the client's calendar. The support address stands in
  // as organiser when the business has no email on file, so the card still
  // shows; replies to the email itself still go to the business.
  const invite =
    link && d.type === "invoice" && when
      ? dueInvite(
          { uid: documentId, business, amount: formatNaira(d.total_kobo), number: d.number, due: when, link },
          { name: business, email: d.business_email ?? env.SUPPORT_EMAIL },
          { name: d.client_name, email: d.client_email },
        )
      : null;

  const sent = await sendEmail(
    {
      to: d.client_email,
      // F21: the user's business name, "via Balans". The client hired them.
      fromName: `${business} via Balans`,
      // And a question about the invoice should reach the person who sent it.
      replyTo: d.business_email ?? undefined,
      subject:
        d.number === null
          ? `${label} from ${business} — ${formatNaira(d.total_kobo)}`
          : `${label} #${d.number} from ${business} — ${formatNaira(d.total_kobo)}`,
      html: layout({
        preheader: `${formatNaira(d.total_kobo)}${when ? `, ${dateWord.toLowerCase()} ${formatFriendly(when)}` : ""}.`,
        // Who it is from, over what it is: the two things a client checks
        // before deciding whether this is a message they have to deal with.
        eyebrow: business,
        heading: `${label}${d.number === null ? "" : ` #${d.number}`}`,
        body,
      }),
      text: [
        `${d.client_name},`,
        "",
        `${business} has sent you ${label.toLowerCase()}${d.number === null ? "" : ` #${d.number}`} for ${formatNaira(d.total_kobo)}${
          when ? `, ${dateWord.toLowerCase()} ${formatFriendly(when)}` : ""
        }.`,
        "",
        link ? (d.type === "quote" ? `View it here: ${link}` : `Pay here: ${link}`) : "",
        "",
        d.notes ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      attachments:
        pdf || invite
          ? [
              ...(pdf ? [{ filename: pdf.filename, content: pdf.bytes }] : []),
              ...(invite ? [invite] : []),
            ]
          : undefined,
    },
    log,
  );

  if (!sent.ok) {
    log.error({ documentId, reason: sent.reason }, "could not email the document to the client");
    return { ok: false, why: "send_failed" };
  }

  log.info({ documentId, to: d.client_email, pro: d.plan === "pro" }, "document emailed to client");
  return { ok: true };
}

/**
 * F21: a bounce marks the address invalid and tells the user once.
 *
 * Once is the point. An address that bounces will bounce on every future
 * invoice, and a user told every time learns to ignore us.
 */
export async function markClientEmailInvalid(
  email: string,
  log: FastifyBaseLogger,
): Promise<{ userId: string; clientName: string }[]> {
  const { rows } = await db().query<{ user_id: string; name: string }>(
    `UPDATE clients SET email_status = 'invalid'
      WHERE lower(email) = lower($1) AND email_status <> 'invalid'
      RETURNING user_id, name`,
    [email],
  );

  if (rows.length) log.warn({ email, clients: rows.length }, "client email marked invalid");
  return rows.map((r) => ({ userId: r.user_id, clientName: r.name }));
}
