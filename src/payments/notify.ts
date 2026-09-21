/**
 * Telling the user they got paid (PRD F16).
 *
 * This is the message the whole product exists to send, and the one people
 * will screenshot. It leads with the money.
 *
 * It is also the one place where a WhatsApp failure must not matter. The
 * payment is already recorded and the client is already out of pocket; if
 * Meta is down, the user finds out when they next ask, and nothing is lost but
 * the moment. So everything here catches, and nothing here throws.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { send } from "../whatsapp/outbound.ts";
import { renderReceiptPdf } from "../documents/pdf.ts";
import { b, block, lines, para, row } from "../whatsapp/format.ts";

export type PaidNotice = {
  userId: string;
  /** The payment that settled it, so the receipt can be rendered from it. */
  paymentId?: string;
  documentType: string;
  documentNumber: number | null;
  clientName: string;
  paidKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  fullyPaid: boolean;
  method: string | null;
};

/** "CARD" and "ACCOUNT_TRANSFER" are not words anybody says out loud. */
const METHOD: Record<string, string> = {
  CARD: "card",
  ACCOUNT_TRANSFER: "bank transfer",
  DIRECT_DEBIT: "direct debit",
  USSD: "USSD",
  PHONE_NUMBER: "phone number",
  CASH: "cash",
};

export function paidMessage(n: PaidNotice): string {
  const label = n.documentType === "quote" ? "Quote" : "Invoice";
  const which = n.documentNumber === null ? label : `${label} ${b(`#${n.documentNumber}`)}`;
  const how = n.method ? METHOD[n.method] ?? n.method.toLowerCase().replace(/_/g, " ") : null;

  if (n.fullyPaid) {
    return para(
      block(`💸 ${b("PAID")}`, [
        row("From", n.clientName),
        row("Amount", b(formatNaira(n.paidKobo))),
        row(label, n.documentNumber === null ? "—" : `#${n.documentNumber}`),
        how && row("Method", how.charAt(0).toUpperCase() + how.slice(1)),
      ]),
      "It is on its way to your bank.",
    );
  }

  const left = n.totalKobo - n.amountPaidKobo;
  return para(
    block(`💰 ${b("PART PAYMENT")}`, [
      row("From", n.clientName),
      row("Received", b(formatNaira(n.paidKobo))),
      row("Still owed", formatNaira(left)),
      row(label, n.documentNumber === null ? "—" : `#${n.documentNumber}`),
      how && row("Method", how.charAt(0).toUpperCase() + how.slice(1)),
    ]),
    "It is on its way to your bank.",
  );
}

/**
 * Sends it, and never lets a send failure surface.
 *
 * The caller has already answered the payment provider. Throwing from here
 * would only produce an unhandled rejection over a message that is, at this
 * point, a courtesy.
 */
export async function notifyPaid(n: PaidNotice, log: FastifyBaseLogger): Promise<void> {
  const { rows } = await db()
    .query<{ wa_phone: string }>(`SELECT wa_phone FROM users WHERE id = $1`, [n.userId])
    .catch(() => ({ rows: [] as { wa_phone: string }[] }));

  const phone = rows[0]?.wa_phone;
  if (!phone) {
    log.error({ userId: n.userId }, "paid, but the user has no number on file");
    return;
  }

  // F11: the receipt goes with the confirmation. It can only be attached
  // inside the window — a template cannot carry a file — and `send` knows
  // which of those it is.
  const receipt = n.paymentId ? await renderReceiptPdf(n.paymentId, log) : null;

  const outcome = await send(
    {
      userId: n.userId,
      phone,
      text: paidMessage(n),
      document: receipt ? { bytes: receipt.bytes, filename: receipt.filename } : undefined,
      // This is the message the whole product exists to send. If the window
      // has closed — and it usually has, because clients pay days later — it
      // goes as a template rather than not at all.
      fallback: {
        template: "payment_received",
        params: [
          formatNaira(n.paidKobo),
          n.clientName,
          n.documentNumber === null ? "" : String(n.documentNumber),
        ],
      },
    },
    log,
  );

  log.info(
    { userId: n.userId, documentNumber: n.documentNumber, outcome: outcome.kind },
    "payment notice",
  );
}
