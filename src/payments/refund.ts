/**
 * Refunds and chargebacks (PRD F10).
 *
 * "Handle refund events: mark refunded, reopen the document if appropriate,
 * notify the user." And for disputes: "mark the payment disputed, notify admin
 * immediately, notify the user, and freeze new invoice creation for that user
 * until reviewed."
 *
 * Money going back out is the one direction where being wrong is worse than
 * being slow, so this reverses exactly what it can account for and leaves
 * anything else to a person. It never reverses more than was taken, and it
 * never reverses the same event twice.
 */

import type { FastifyBaseLogger } from "fastify";
import { db, tx } from "../db/pool.ts";
import { formatNaira } from "../../core/totals.ts";
import { b, lines, para } from "../whatsapp/format.ts";
import { sendText } from "../whatsapp/client.ts";
import { recordOutbound } from "../conversation/store.ts";

export type ReversalOutcome =
  | { kind: "reversed"; reference: string; partial: boolean }
  | { kind: "already_reversed"; reference: string }
  | { kind: "unknown_payment"; providerReference: string }
  /** The payment was never successful, so there is nothing to give back. */
  | { kind: "not_applicable"; reference: string; status: string };

/**
 * Undoes a payment on the document it settled.
 *
 * `amountKobo` is what actually went back. A partial refund leaves the
 * document part-paid rather than unpaid, because the client is still owed the
 * difference and an invoice that silently reverts to unpaid would be chased
 * for the whole amount.
 */
export async function reversePayment(
  input: {
    providerReference: string;
    amountKobo: number | null;
    /** 'refunded' for a refund, 'disputed' for a chargeback. */
    to: "refunded" | "disputed";
    raw: unknown;
  },
  log: FastifyBaseLogger,
): Promise<ReversalOutcome> {
  const { rows } = await db().query<{
    id: string;
    reference: string;
    document_id: string;
    status: string;
    client_total_kobo: number;
  }>(
    `SELECT id, reference, document_id, status, client_total_kobo
       FROM payments WHERE provider_reference = $1
       ORDER BY created_at DESC LIMIT 1`,
    [input.providerReference],
  );

  const payment = rows[0];
  if (!payment) return { kind: "unknown_payment", providerReference: input.providerReference };

  if (payment.status === "refunded" || payment.status === "disputed") {
    return { kind: "already_reversed", reference: payment.reference };
  }

  // Only a payment that actually landed can be given back. Anything else is an
  // event about a transaction that never credited anybody.
  if (payment.status !== "success") {
    return { kind: "not_applicable", reference: payment.reference, status: payment.status };
  }

  // A refund with no amount named is a full one; that is the common case and
  // the only safe reading of a missing figure.
  const reversedKobo = Math.min(input.amountKobo ?? payment.client_total_kobo, payment.client_total_kobo);

  const result = await tx(async (c) => {
    const claimed = await c.query(
      `UPDATE payments SET status = $2, raw_verify_json = $3
        WHERE id = $1 AND status = 'success'`,
      [payment.id, input.to, JSON.stringify(input.raw)],
    );
    if (claimed.rowCount === 0) return null;

    const { rows: docs } = await c.query<{
      user_id: string;
      type: string;
      number: number | null;
      total_kobo: number;
      amount_paid_kobo: number;
      client_name: string;
    }>(
      `SELECT d.user_id, d.type, d.number, d.total_kobo, d.amount_paid_kobo, cl.name AS client_name
         FROM documents d JOIN clients cl ON cl.id = d.client_id
        WHERE d.id = $1 FOR UPDATE OF d`,
      [payment.document_id],
    );
    const doc = docs[0];
    if (!doc) throw new Error(`refund for ${payment.reference} points at a document that is gone`);

    const paid = Math.max(0, doc.amount_paid_kobo - reversedKobo);
    // Back to sent rather than draft: the document was issued and the client
    // has seen it. It is owed again, not unmade.
    const status = paid === 0 ? "sent" : "part_paid";

    await c.query(
      `UPDATE documents
          SET amount_paid_kobo = $2,
              status = $3,
              paid_at = CASE WHEN $2 = 0 THEN NULL ELSE paid_at END
        WHERE id = $1`,
      [payment.document_id, paid, status],
    );

    return { ...doc, paidAfter: paid };
  });

  if (!result) return { kind: "already_reversed", reference: payment.reference };

  log.warn(
    {
      reference: payment.reference,
      documentId: payment.document_id,
      reversedKobo,
      to: input.to,
      paidAfter: result.paidAfter,
    },
    input.to === "disputed" ? "payment disputed" : "payment refunded",
  );

  // A chargeback is a risk event, not just an accounting one. F10 freezes new
  // documents for that user until somebody has looked at it.
  if (input.to === "disputed") {
    await flagForReview(result.user_id, payment.reference, log);
  }

  void notifyReversed(
    {
      userId: result.user_id,
      documentType: result.type,
      documentNumber: result.number,
      clientName: result.client_name,
      reversedKobo,
      to: input.to,
      stillPaidKobo: result.paidAfter,
    },
    log,
  );

  return { kind: "reversed", reference: payment.reference, partial: result.paidAfter > 0 };
}

/**
 * Pauses the account and records why (PRD section 13).
 *
 * A paused user can still be paid on invoices already sent — the machine's
 * `paused` branch says exactly that — but cannot create new ones until a
 * person has looked.
 */
async function flagForReview(
  userId: string,
  reference: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await tx(async (c) => {
      await c.query(`UPDATE users SET status = 'paused' WHERE id = $1 AND status = 'active'`, [userId]);
      await c.query(
        `INSERT INTO risk_flags (user_id, kind, detail, status)
         VALUES ($1, 'chargeback', $2, 'open')`,
        [userId, `chargeback on payment ${reference}`],
      );
    });
    log.error({ userId, reference }, "user paused after a chargeback");
  } catch (err) {
    // The refund itself is already applied; failing to flag must not undo it.
    log.error({ err, userId }, "could not flag the account after a chargeback");
  }
}

/* -------------------------------------------------------------------------- */

type ReversedNotice = {
  userId: string;
  documentType: string;
  documentNumber: number | null;
  clientName: string;
  reversedKobo: number;
  to: "refunded" | "disputed";
  stillPaidKobo: number;
};

export function reversedMessage(n: ReversedNotice): string {
  const label = n.documentType === "quote" ? "Quote" : "Invoice";
  const which = n.documentNumber === null ? label.toLowerCase() : `${label} ${b(`#${n.documentNumber}`)}`;

  if (n.to === "disputed") {
    return para(
      `⚠️ ${b(formatNaira(n.reversedKobo))} on ${which} has been disputed by ${n.clientName}.`,
      lines(
        "Their bank is reversing it while they look into it.",
        "New invoices are on hold until we have reviewed it — payments on invoices you already sent still work.",
      ),
      "We have emailed you. Reply here if you want to talk it through.",
    );
  }

  return para(
    `↩️ ${b(formatNaira(n.reversedKobo))} on ${which} has been refunded to ${n.clientName}.`,
    n.stillPaidKobo > 0
      ? `${formatNaira(n.stillPaidKobo)} of that invoice is still paid.`
      : "The invoice is showing as unpaid again.",
  );
}

async function notifyReversed(n: ReversedNotice, log: FastifyBaseLogger): Promise<void> {
  try {
    const { rows } = await db().query<{ wa_phone: string }>(
      `SELECT wa_phone FROM users WHERE id = $1`,
      [n.userId],
    );
    const phone = rows[0]?.wa_phone;
    if (!phone) return;

    const res = await sendText(phone, reversedMessage(n));
    await recordOutbound(n.userId, res.ok ? res.waMessageId : null, res.ok ? "sent" : "failed");
  } catch (err) {
    log.error({ err, userId: n.userId }, "could not send the reversal notice");
  }
}
