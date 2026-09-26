/**
 * The overdue reminder, sent to the client as well (Pro: "Automatic emails
 * to your client" on the pricing table, and promised in the Pro welcome).
 *
 * Until now every reminder went only to the sender on WhatsApp, with a
 * message to forward. The client is the one who has to act, so on Pro they
 * get it themselves, by email: WhatsApp cannot reach a client who never
 * opted in to hearing from us, and an email from "Business via Balans" with
 * the reply-to set to the business is the channel that can.
 *
 * Polite and plain, as the forwardable version is: most late invoices are
 * forgotten, not refused. And it says what to do if they already paid,
 * because on a naira invoice paid by direct transfer nothing tells us that
 * except the sender.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { documentLink } from "../documents/links.ts";
import { sendEmail } from "./send.ts";
import { amount, button, layout, paragraph } from "./layout.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type ReminderEmail = { to: string; fromName: string; replyTo?: string; subject: string; html: string; text: string };

/** The email itself, from the facts. Exported so it can be read in a test. */
export function reminderEmail(x: {
  to: string;
  clientName: string;
  business: string;
  businessEmail: string | null;
  number: number | null;
  owedKobo: number;
  due: Civil;
  today: Civil;
  link: string;
  bankTransfer: boolean;
}): ReminderEmail {
  const which = x.number === null ? "the invoice" : `invoice #${x.number}`;
  const owed = formatNaira(x.owedKobo);
  const when = formatFriendly(x.due, x.today);
  const body = [
    paragraph(`${esc(x.clientName)},`),
    paragraph(`A friendly reminder that ${which} from ${esc(x.business)} was due ${esc(when)}.`),
    amount("Still to pay", owed, `Was due ${when}`),
    // A naira invoice's link opens the business's own account; one abroad,
    // the card checkout. The button says which.
    button(x.bankTransfer ? "See how to pay" : `Pay ${owed}`, x.link),
    paragraph(
      `Already paid? Thank you — just reply to this email to let ${esc(x.business)} know.`,
      true,
    ),
  ].join("\n");

  return {
    to: x.to,
    fromName: `${x.business} via Balans`,
    replyTo: x.businessEmail ?? undefined,
    subject: `Reminder: ${which} from ${x.business} — ${owed}`,
    html: layout({
      preheader: `${owed}, due ${when}.`,
      eyebrow: x.business,
      heading: "A quick reminder",
      body,
    }),
    text: [
      `${x.clientName},`,
      "",
      `A friendly reminder that ${which} from ${x.business} for ${owed} was due ${when}.`,
      "",
      `${x.bankTransfer ? "How to pay" : "Pay here"}: ${x.link}`,
      "",
      `Already paid? Thank you — just reply to let ${x.business} know.`,
    ].join("\n"),
  };
}

/**
 * Sends it for one invoice, when the sender is on Pro and the client has an
 * email that has not bounced. Returns whether it went.
 */
export async function emailReminderToClient(
  documentId: string,
  today: Civil,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const { rows } = await db().query<{
    number: number | null;
    type: string;
    total_kobo: number;
    amount_paid_kobo: number;
    due_date: Date | null;
    public_token: string | null;
    delivery_type: string;
    client_name: string;
    client_email: string | null;
    email_status: string | null;
    business_name: string | null;
    business_email: string | null;
    plan: "free" | "pro";
  }>(
    `SELECT d.number, d.type, d.total_kobo, d.amount_paid_kobo, d.due_date, d.public_token, d.delivery_type,
            c.name AS client_name, c.email AS client_email, c.email_status,
            u.business_name, u.email AS business_email, u.plan
       FROM documents d
       JOIN clients c ON c.id = d.client_id
       JOIN users u   ON u.id = d.user_id
      WHERE d.id = $1`,
    [documentId],
  );
  const d = rows[0];
  // Not to an address that has bounced or complained (F21 marks them).
  const undeliverable = ["bounced", "complained", "invalid"].includes(d?.email_status ?? "");
  if (!d || d.plan !== "pro" || !d.client_email || undeliverable) return false;
  if (!d.public_token || !d.due_date || d.total_kobo <= d.amount_paid_kobo) return false;

  const mail = reminderEmail({
    to: d.client_email,
    clientName: d.client_name,
    business: d.business_name ?? "A Balans user",
    businessEmail: d.business_email,
    number: d.number,
    owedKobo: d.total_kobo - d.amount_paid_kobo,
    due: { y: d.due_date.getFullYear(), m: d.due_date.getMonth() + 1, d: d.due_date.getDate() },
    today,
    link: documentLink(d.type, d.public_token),
    bankTransfer: d.delivery_type === "bank_details",
  });

  const sent = await sendEmail(mail, log);
  if (!sent.ok) {
    log.error({ documentId, reason: sent.reason }, "could not email the reminder to the client");
    return false;
  }
  log.info({ documentId }, "reminder emailed to client");
  return true;
}
