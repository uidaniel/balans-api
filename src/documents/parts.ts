/**
 * Deposits and milestones (PRD F7).
 *
 * "Invoice Zenith 350k, 50% deposit" is one invoice with two payment parts, not
 * two invoices. That distinction runs through everything here: there is one
 * number, one link, one document the client sees — and two buttons on it.
 *
 * The arithmetic is `splitInto`, which already guarantees the parts sum to the
 * total exactly. What this adds is the ordering rule: only the next unpaid
 * part is payable, so a client cannot pay the balance before the deposit and
 * leave the user chasing the smaller half.
 */

import type pg from "pg";

import { db, tx } from "../db/pool.ts";
import { splitInto } from "../../core/totals.ts";

export type Part = {
  id: string;
  position: number;
  label: string;
  amountKobo: number;
  status: "pending" | "payable" | "paid";
  paidAt: Date | null;
};

/**
 * Writes the parts for a document.
 *
 * The first is `payable` and the rest `pending`: F7's rule that only the next
 * unpaid part can be paid is expressed in the data, not just in the page, so
 * a client who guesses a URL still cannot pay out of order.
 */
export async function createParts(
  documentId: string,
  totalKobo: number,
  shape: Shape,
  /**
   * An open transaction to write inside.
   *
   * The parts and the document they belong to are written together or not at
   * all: a draft that exists with no parts is an invoice for the full amount,
   * which is the failure this whole file is meant to prevent.
   */
  client?: pg.PoolClient,
): Promise<Part[]> {
  const amounts = splitInto(
    totalKobo,
    shape.map((s) => s.percent),
  );

  const write = async (c: pg.PoolClient): Promise<Part[]> => {
    await c.query(`DELETE FROM payment_parts WHERE document_id = $1`, [documentId]);

    const made: Part[] = [];
    for (const [i, s] of shape.entries()) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO payment_parts (document_id, position, label, amount_kobo, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [documentId, i, s.label, amounts[i]!, i === 0 ? "payable" : "pending"],
      );
      made.push({
        id: rows[0]!.id,
        position: i,
        label: s.label,
        amountKobo: amounts[i]!,
        status: i === 0 ? "payable" : "pending",
        paidAt: null,
      });
    }
    return made;
  };

  return client ? write(client) : tx(write);
}

/** How a total is broken up. The percentages always add to 100. */
export type Shape = { label: string; percent: number }[];

/**
 * The shape a document's options ask for, or null for one single payment.
 *
 * This is the only place that answers the question, so the draft summary, the
 * stored parts and the payment page cannot disagree about whether an invoice
 * is paid in one go.
 *
 * A deposit wins over instalments when both are somehow set. They are two
 * answers to the same question and the deposit is the one the user is far more
 * likely to have said out loud.
 *
 * 100% is not a deposit. It is the whole invoice, and `depositShape` would
 * make a second part worth nothing — which `payment_parts` rejects outright,
 * because a part worth zero is not something a client can pay.
 */
export function shapeFor(o: {
  depositPercent?: number | null;
  instalments?: number | null;
}): Shape | null {
  const deposit = o.depositPercent;
  if (deposit != null && deposit > 0 && deposit < 100) return depositShape(deposit);

  const n = o.instalments;
  if (n != null && n >= MIN_INSTALMENTS && n <= MAX_INSTALMENTS) return equalShape(n);

  return null;
}

/**
 * Two is the fewest that means anything, and twelve is where it stops being a
 * payment plan and starts being a subscription we do not do.
 */
export const MIN_INSTALMENTS = 2;
export const MAX_INSTALMENTS = 12;

/** A deposit, as F7 writes it: "50% deposit" is deposit then balance. */
export const depositShape = (percent: number): Shape => [
  { label: `${percent}% deposit`, percent },
  { label: "Balance", percent: 100 - percent },
];

/** "three equal parts", with the rounding remainder on the last one. */
export function equalShape(n: number): Shape {
  const each = Math.floor((100 / n) * 100) / 100;
  const shape = Array.from({ length: n }, (_, i) => ({
    label: `Part ${i + 1} of ${n}`,
    percent: each,
  }));
  // splitInto insists the percentages total 100, and the last one absorbs the
  // rounding here exactly as it absorbs the kobo there.
  shape[n - 1]!.percent = Math.round((100 - each * (n - 1)) * 100) / 100;
  return shape;
}

export async function partsFor(documentId: string): Promise<Part[]> {
  const { rows } = await db().query<{
    id: string;
    position: number;
    label: string;
    amount_kobo: number;
    status: Part["status"];
    paid_at: Date | null;
  }>(
    `SELECT id, position, label, amount_kobo, status, paid_at
       FROM payment_parts WHERE document_id = $1 ORDER BY position`,
    [documentId],
  );

  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    label: r.label,
    amountKobo: r.amount_kobo,
    status: r.status,
    paidAt: r.paid_at,
  }));
}

/** What the client can pay right now: the next unpaid part (F7). */
export const nextPayable = (parts: Part[]): Part | null =>
  parts.find((p) => p.status !== "paid") ?? null;

/**
 * Marks a part paid and opens the one after it.
 *
 * Driven by amount rather than by id, because the payment came back from
 * Monnify with a reference and a figure, not with our part id. The smallest
 * unpaid part that the payment covers is the one it settled.
 */
export async function settleParts(
  documentId: string,
  paidKobo: number,
): Promise<{ settled: Part[]; allPaid: boolean }> {
  return tx(async (c) => {
    const { rows } = await c.query<{
      id: string;
      position: number;
      label: string;
      amount_kobo: number;
      status: Part["status"];
    }>(
      `SELECT id, position, label, amount_kobo, status
         FROM payment_parts WHERE document_id = $1 ORDER BY position
         FOR UPDATE`,
      [documentId],
    );

    if (!rows.length) return { settled: [], allPaid: true };

    let remaining = paidKobo;
    const settled: Part[] = [];

    for (const p of rows) {
      if (p.status === "paid") continue;
      // A payment that does not cover this part leaves it unpaid: a part is
      // paid or it is not, and a partly-paid part is a state nothing else
      // knows how to read.
      if (remaining < p.amount_kobo) break;

      await c.query(`UPDATE payment_parts SET status = 'paid', paid_at = now() WHERE id = $1`, [
        p.id,
      ]);
      remaining -= p.amount_kobo;
      settled.push({
        id: p.id,
        position: p.position,
        label: p.label,
        amountKobo: p.amount_kobo,
        status: "paid",
        paidAt: new Date(),
      });
    }

    // Open the next one, so the page has a button again.
    const { rows: left } = await c.query<{ id: string }>(
      `SELECT id FROM payment_parts
        WHERE document_id = $1 AND status <> 'paid'
        ORDER BY position LIMIT 1`,
      [documentId],
    );

    if (left[0]) {
      await c.query(`UPDATE payment_parts SET status = 'payable' WHERE id = $1`, [left[0].id]);
    }

    return { settled, allPaid: left.length === 0 };
  });
}
