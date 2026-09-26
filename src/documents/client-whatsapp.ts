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
  number: number | null;
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
    number: number | null;
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
    `SELECT d.user_id, d.type, d.number, d.total_kobo, d.subtotal_kobo, d.vat_kobo, d.currency,
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

  const { template, params } = clientMessage({ ...d, amount: amountFor(d) });
  const sent = await sendTemplate(d.client_phone, template, params, {
    language: TEMPLATE_LANGUAGE,
    urlSuffix: d.public_token,
  });

  if (!sent.ok) {
    log.error({ documentId, template, reason: sent.reason }, "could not send the document to the client's WhatsApp");
    return { ok: false, why: "send_failed", to: d.client_phone };
  }
  log.info({ documentId, template }, "document sent to the client's WhatsApp");
  return { ok: true, to: d.client_phone };
}
