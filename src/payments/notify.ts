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
import { settlesTonight } from "./settlement.ts";
import { defaults, env } from "../config.ts";
import { renderReceiptPdf } from "../documents/pdf.ts";
import { proStarted } from "../billing/messages.ts";
import { PRO_CARD } from "../conversation/machine.ts";
import { proEmail, sendEmail } from "../email/send.ts";
import { emailPaidToClient, emailPaidToUser } from "../email/paid-delivery.ts";
import { displayNumber } from "../whatsapp/number.ts";

/**
 * The membership card for the month somebody joined in.
 *
 * Lagos, not the server's idea of the date: a subscription paid at half past
 * midnight on the 1st is a member since that month, and UTC would say the
 * one before.
 */
function proCardUrl(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: defaults.behaviour.timezone,
    year: "numeric",
    month: "2-digit",
  }).format(at);
  return `${PRO_CARD}?m=${parts}`;
}
import { b, block, lines, para, row } from "../whatsapp/format.ts";
import { arrivalLine } from "./settlement.ts";

export type PaidNotice = {
  userId: string;
  /** The payment that settled it, so the receipt can be rendered from it. */
  paymentId?: string;
  /**
   * The document it paid, so the two emails can be sent from it.
   *
   * Optional because a payment can exist without one — a subscription paid by
   * link is a payment with no invoice behind it — and those send nothing.
   */
  documentId?: string;
  documentType: string;
  documentNumber: number | null;
  clientName: string;
  paidKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  fullyPaid: boolean;
  method: string | null;
  /**
   * Which processor took it, because they settle on different schedules.
   *
   * Defaults to Monnify, which is every naira payment and so nearly all of
   * them. A card payment described with Monnify's wording is a promise that
   * the money is in somebody's bank tonight when it is not.
   */
  provider?: "monnify" | "paystack";
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

export function paidMessage(n: PaidNotice, at: Date = new Date()): string {
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
      arrivalLine(at, n.provider),
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
    arrivalLine(at, n.provider),
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

  /*
   * Which card, decided by the clock rather than written into the message.
   *
   * Monnify settles once a day at 22:00 Lagos. A payment before it is in the
   * bank tonight; after it, tomorrow night. Both cards say so in as many
   * words, and `settlesTonight` is the same function the caption uses — so
   * the picture and the words underneath it cannot disagree.
   */
  const at = new Date();
  /*
   * No card on a Paystack payment, deliberately.
   *
   * Both posters say "tonight" or "tomorrow night" in as many words, and
   * those are claims about Monnify's 22:00 run. Sending one with a card
   * payment would put a promise in the picture that the sentence underneath
   * it contradicts — and of the two, the picture is what gets screenshotted.
   * A poster of its own can come later; a wrong one cannot go now.
   */
  const card =
    n.provider === "paystack"
      ? undefined
      : `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/brand/${
          settlesTonight(at) ? "paid-tonight.png" : "paid-tomorrow.png"
        }`;

  const outcome = await send(
    {
      userId: n.userId,
      phone,
      text: paidMessage(n, at),
      image: card,
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

  /*
   * And the paperwork, by email, to both sides.
   *
   * After the WhatsApp message and never in front of it. The chat is where
   * this product lives and the message above is the one people screenshot;
   * rendering two PDFs and talking to a mail provider must not stand between
   * a payment and somebody hearing about it.
   *
   * Only when the invoice is settled in full. A deposit is not a paid invoice
   * and stamping one PAID would be a lie on a document somebody files.
   *
   * Not awaited, and neither call throws. The money has already moved.
   */
  if (n.documentId && n.fullyPaid) {
    void emailPaidToClient(n.documentId, log);
    void emailPaidToUser(n.documentId, log);
  }
}

/**
 * Telling somebody their Pro payment landed (F18).
 *
 * Separate from `notifyPaid` because nothing about it is an invoice: there is
 * no client, no document and no receipt to attach. What matters is that the
 * subscription is already active by the time this runs — the message is the
 * courtesy, not the mechanism, so a WhatsApp failure here costs a message and
 * never a month somebody paid for.
 */
export async function notifyProActive(
  userId: string,
  until: Date,
  log: FastifyBaseLogger,
  paidKobo?: number,
): Promise<void> {
  const { rows } = await db()
    .query<{ wa_phone: string }>(`SELECT wa_phone FROM users WHERE id = $1`, [userId])
    .catch(() => ({ rows: [] as { wa_phone: string }[] }));

  const phone = rows[0]?.wa_phone;
  if (!phone) {
    log.error({ userId }, "pro activated, but the user has no number on file");
    return;
  }

  const outcome = await send(
    {
      userId,
      phone,
      text: proStarted(paidKobo ? { paidKobo, until } : undefined),
      /*
       * The card, with the confirmation underneath it.
       *
       * Worth the picture: this is the one message in the product somebody
       * has actually paid for. The month is theirs — it is the moment they
       * became a member, which is now — rather than the one painted into the
       * artwork, so a card issued in March does not say September.
       */
      image: proCardUrl(new Date()),
      // Outside the window this is worth a template: somebody who has just
      // parted with ₦4,000 should not wait a day to hear it worked.
      fallback: {
        template: "pro_renewal",
        params: [until.toLocaleDateString("en-GB", { day: "numeric", month: "long" })],
      },
    },
    log,
  );

  if (outcome.kind === "failed") {
    log.error({ userId, reason: outcome.reason }, "could not confirm Pro activation");
  }
}

/**
 * The same news by email, to the verified address only.
 *
 * Whether it is their first month is counted rather than remembered: a
 * subscription that has taken any money is a month they have paid for, and
 * the one that just activated is among them. One means this is the start.
 *
 * Best effort, like the message above it. The month is already theirs.
 */
export async function emailProActive(
  userId: string,
  until: Date,
  paidKobo: number,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const { rows } = await db().query<{
      email: string | null;
      business_name: string | null;
      paid_periods: number;
    }>(
      `SELECT CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END AS email,
              u.business_name,
              (SELECT count(*)::int FROM subscriptions s
                WHERE s.user_id = u.id AND s.amount_collected_kobo > 0) AS paid_periods
         FROM users u
        WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r?.email) return;

    const sent = await sendEmail(
      {
        to: r.email,
        ...proEmail({
          businessName: r.business_name,
          first: r.paid_periods <= 1,
          amountKobo: paidKobo,
          until,
          waNumber: await displayNumber(),
        }),
      },
      log,
    );
    if (!sent.ok) log.warn({ userId, reason: sent.reason }, "Pro email not sent");
  } catch (err) {
    log.error({ userId, err: (err as Error).message }, "Pro email failed");
  }
}
