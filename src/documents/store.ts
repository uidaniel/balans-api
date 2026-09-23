/**
 * Documents: drafts, numbering and confirmation (PRD F6).
 *
 * A draft is a real row with status 'draft' and no number. That costs one
 * insert and buys two things: a draft survives a restart, and the confirm step
 * has nothing to recompute — it numbers the row that was already shown, so
 * what the user approved is exactly what goes out.
 */

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { db, tx } from "../db/pool.ts";
import { createParts, partsFor, stagesFor, type Part } from "./parts.ts";
import { formatISO, type Civil } from "../../core/dates.ts";
import { totalsFor, type Line } from "../../core/totals.ts";

export type DocumentType = "invoice" | "quote" | "payment_request" | "sample";

export type DraftInput = {
  type: DocumentType;
  clientName: string;
  clientEmail: string | null;
  lines: Line[];
  /**
   * The date on the document: when an invoice falls due, or when a quote
   * expires. One field here, two columns in the table — `documents.due_date`
   * drives the overdue sweep and reminders, and a quote must never appear in
   * either, so a quote's date goes to `valid_until` instead (F5).
   */
  dueDate: Civil | null;
  vatPercent: number | null;
  depositPercent: number | null;
  /** Equal payments, when the work is billed in stages rather than up front. */
  instalments: number | null;
  /**
   * Dates set for particular parts, by position.
   *
   * Without this the plan was rebuilt from the issue date and the due date
   * when the document was written, so a deposit somebody had moved to Friday
   * went back to "due now" the moment they tapped Send — the summary would
   * have been right and the invoice wrong.
   */
  stageDueDates?: (Civil | null)[] | null;
  passFeesToClient: boolean;
  notes: string | null;
};

export type Draft = DraftInput & {
  id: string;
  clientId: string;
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  number: number | null;
  publicToken: string | null;
};

/* -------------------------------------------------------------------------- */
/* Clients (F4)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Finds a client by name, or creates one.
 *
 * Case-insensitive on a trimmed name: "tunde", "Tunde" and "Tunde " are one
 * person, and a freelancer who ends up with three Tundes has three sets of
 * history for one client. F4's fuzzy matching and the "which one did you
 * mean?" question come with saved clients in v1.1; this is the exact match
 * that has to be right first.
 */
export async function findOrCreateClient(
  userId: string,
  name: string,
  email: string | null,
  client?: PoolClient,
): Promise<string> {
  const q = client ?? db();
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM clients
      WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL
      ORDER BY created_at
      LIMIT 1`,
    [userId, name],
  );

  if (rows[0]) {
    // An email we did not have before is worth keeping; one we did is not
    // worth overwriting from a passing mention.
    if (email) {
      await q.query(
        `UPDATE clients SET email = $2 WHERE id = $1 AND (email IS NULL OR email = '')`,
        [rows[0].id, email],
      );
    }
    return rows[0].id;
  }

  const created = await q.query<{ id: string }>(
    `INSERT INTO clients (user_id, name, email) VALUES ($1, btrim($2), $3) RETURNING id`,
    [userId, name, email],
  );
  return created.rows[0]!.id;
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                     */
/**
 * Reads a document's split back off its parts.
 *
 * Same principle as `vatPercent` above: recovered from what was stored rather
 * than kept as a second copy of the answer, because two records of one number
 * are two things that can disagree.
 *
 * The deposit case is the pair `createParts` writes for `depositShape` — a
 * first part and a "Balance". Anything else with more than one part is a set
 * of equal instalments, and its count is the whole of what there is to know.
 */
function splitOf(
  parts: Part[],
  totalKobo: number,
): { depositPercent: number | null; instalments: number | null } {
  if (parts.length < 2 || totalKobo <= 0) {
    return { depositPercent: null, instalments: null };
  }

  if (parts.length === 2 && parts[1]!.label === "Balance") {
    return { depositPercent: round1((parts[0]!.amountKobo / totalKobo) * 100), instalments: null };
  }

  return { depositPercent: null, instalments: parts.length };
}

/* -------------------------------------------------------------------------- */

/**
 * Replaces the user's open draft with a new one.
 *
 * One open draft per user, by construction. Two drafts in a chat window is a
 * question about which one "yes" meant, and there is no good answer to it.
 */
export async function createDraft(
  userId: string,
  input: DraftInput,
  /**
   * The day this is being written, which is the day the first payment falls
   * due. A draft has no `issue_date` yet — that is set when it is sent — and
   * the plan's dates have to be decided before anybody approves them, not
   * after.
   */
  issuedOn: Civil,
): Promise<Draft> {
  const totals = totalsFor(input.lines, input.vatPercent);

  return tx(async (c) => {
    await c.query(`DELETE FROM documents WHERE user_id = $1 AND status = 'draft'`, [userId]);

    const clientId = await findOrCreateClient(userId, input.clientName, input.clientEmail, c);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO documents
         (user_id, client_id, type, status, subtotal_kobo, vat_kobo, total_kobo,
          pass_fees_to_client, due_date, valid_until, notes)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        userId,
        clientId,
        input.type,
        totals.subtotalKobo,
        totals.vatKobo,
        totals.totalKobo,
        input.passFeesToClient,
        input.type === "quote" || !input.dueDate ? null : formatISO(input.dueDate),
        input.type === "quote" && input.dueDate ? formatISO(input.dueDate) : null,
        input.notes,
      ],
    );
    const id = rows[0]!.id;

    for (const [i, line] of input.lines.entries()) {
      await c.query(
        `INSERT INTO line_items (document_id, position, description, qty, unit_amount_kobo, amount_kobo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, i, line.description, line.qty, line.unitAmountKobo, totals.lineTotalsKobo[i]!],
      );
    }

    /*
     * A deposit or a set of instalments becomes rows, here, in the same
     * transaction as the document.
     *
     * For a long time it did not. The deposit was parsed, shown on the draft
     * as "Deposit — 50% up front", confirmed by the user, and then dropped on
     * the floor: nothing ever called `createParts`, so the payment page found
     * no parts and asked the client for the whole amount. The user had been
     * told one thing and their client was shown another, which is the worst
     * shape a bug in this product can take.
     */
    const stages = stagesFor(input, totals.totalKobo, issuedOn);
    if (stages) await createParts(id, stages, c);

    return {
      ...input,
      id,
      clientId,
      subtotalKobo: totals.subtotalKobo,
      vatKobo: totals.vatKobo,
      totalKobo: totals.totalKobo,
      number: null,
      publicToken: null,
    };
  });
}

export async function getOpenDraft(userId: string): Promise<Draft | null> {
  const { rows } = await db().query<{
    id: string;
    client_id: string;
    type: DocumentType;
    subtotal_kobo: number;
    vat_kobo: number;
    total_kobo: number;
    pass_fees_to_client: boolean;
    due_date: Date | null;
    valid_until: Date | null;
    notes: string | null;
    number: number | null;
    public_token: string | null;
    client_name: string;
    client_email: string | null;
  }>(
    `SELECT d.id, d.client_id, d.type, d.subtotal_kobo, d.vat_kobo, d.total_kobo,
            d.pass_fees_to_client, d.due_date, d.valid_until, d.notes, d.number, d.public_token,
            c.name AS client_name, c.email AS client_email
       FROM documents d
       JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.status = 'draft'
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [userId],
  );

  const row = rows[0];
  if (!row) return null;

  const { rows: items } = await db().query<{
    description: string;
    qty: string;
    unit_amount_kobo: number;
  }>(
    `SELECT description, qty, unit_amount_kobo FROM line_items
      WHERE document_id = $1 ORDER BY position`,
    [row.id],
  );

  const parts = await partsFor(row.id);

  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type,
    clientName: row.client_name,
    clientEmail: row.client_email,
    // NUMERIC comes back as a string, for the same precision reason BIGINT
    // does. Quantities are small and bounded, so a Number is safe here.
    lines: items.map((i) => ({
      description: i.description,
      qty: Number(i.qty),
      unitAmountKobo: i.unit_amount_kobo,
    })),
    dueDate: civilOrNull(row.due_date ?? row.valid_until),
    // Recovered from the stored money rather than kept as a second copy: two
    // sources for one number is how they end up disagreeing.
    vatPercent: row.vat_kobo > 0 ? round1((row.vat_kobo / row.subtotal_kobo) * 100) : null,
    ...splitOf(parts, row.total_kobo),
    passFeesToClient: row.pass_fees_to_client,
    notes: row.notes,
    subtotalKobo: row.subtotal_kobo,
    vatKobo: row.vat_kobo,
    totalKobo: row.total_kobo,
    number: row.number,
    publicToken: row.public_token,
  };
}

export async function discardDraft(userId: string): Promise<void> {
  await db().query(`DELETE FROM documents WHERE user_id = $1 AND status = 'draft'`, [userId]);
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                               */
/* -------------------------------------------------------------------------- */

export type Confirmed = { id: string; number: number; publicToken: string; type: DocumentType };

/**
 * Turns the open draft into a sent document.
 *
 * The number comes from a locked count inside the transaction. Two messages
 * arriving together — a double tap on "yes", or Meta redelivering — would
 * otherwise both read "the highest number is 6" and both write 7, and the
 * unique index would reject the second with an error the user cannot act on.
 *
 * `FOR UPDATE` on the user's row is what serialises it: concurrent confirms
 * for the same user queue, and confirms for different users do not.
 */
export async function confirmDraft(userId: string, draftId: string): Promise<Confirmed | null> {
  return tx(async (c) => {
    await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

    const { rows } = await c.query<{ id: string; type: DocumentType }>(
      `SELECT id, type FROM documents
        WHERE id = $1 AND user_id = $2 AND status = 'draft'
        FOR UPDATE`,
      [draftId, userId],
    );
    const draft = rows[0];
    if (!draft) return null;

    // GREATEST, so the user's chosen start only ever skips forward. A start
    // set below what has already been issued changes nothing, and numbers
    // can never repeat or go backwards whatever is configured.

    // F8: a payment request is "numbered in the invoice sequence". A client
    // receiving request 4 and invoice 4 from the same person would reasonably
    // think one was a duplicate of the other.
    const sequence = draft.type === "payment_request" ? "invoice" : draft.type;

    const { rows: numbered } = await c.query<{ next: number }>(
      `SELECT GREATEST(
                COALESCE(MAX(d.number), 0) + 1,
                (SELECT u.invoice_number_start FROM users u WHERE u.id = $1)
              ) AS next
         FROM documents d
        WHERE d.user_id = $1
          AND d.type = ANY($2)`,
      [userId, sequence === "invoice" ? ["invoice", "payment_request"] : [sequence]],
    );
    const number = numbered[0]!.next;

    // Unguessable, and the only key a client needs (section 11). 32 hex
    // characters is 128 bits: not enumerable, and short enough for a URL.
    const publicToken = randomBytes(16).toString("hex");

    /*
     * The reference, which belongs to nobody's sequence.
     *
     * `number` above restarts at 1 for every freelancer, because that is what
     * an invoice number means to the client reading it. Which makes it no use
     * for support: "invoice 2 has not been paid" names one invoice per user
     * on the whole platform. This one is unique across everybody, and it is
     * what the admin panel searches.
     *
     * From a sequence, in this transaction, so two people sending at the same
     * moment cannot be handed the same one — which MAX(...) + 1 would do, and
     * the loser of that race is somebody's invoice failing to send.
     *
     * Padded to four digits and then simply longer. "BL-0042" survives being
     * written on paper and read back down a phone, which is the entire job.
     */
    const { rows: refs } = await c.query<{ ref: string }>(
      `SELECT 'BL-' || LPAD(nextval('document_ref_seq')::text, 4, '0') AS ref`,
    );
    const ref = refs[0]!.ref;

    await c.query(
      `UPDATE documents
          SET number = $2, status = 'sent', public_token = $3, ref = $4,
              issue_date = CURRENT_DATE, sent_at = now()
        WHERE id = $1`,
      [draft.id, number, publicToken, ref],
    );

    return { id: draft.id, number, ref, publicToken, type: draft.type };
  });
}

/**
 * Removes drafts nobody confirmed (F6: discarded after 24 hours).
 *
 * Returns how many went, so the sweep can be seen in the logs rather than
 * guessed at.
 */
export async function sweepStaleDrafts(olderThanHours = 24): Promise<number> {
  const { rowCount } = await db().query(
    `DELETE FROM documents
      WHERE status = 'draft' AND created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours],
  );
  return rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */

/** A DATE column comes back as a Date at local midnight; only the parts matter. */
const civilOrNull = (d: Date | null): Civil | null =>
  d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null;

const round1 = (n: number): number => Math.round(n * 10) / 10;
