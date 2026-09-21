/**
 * Loading a document for its public page (PRD F9).
 *
 * The token is the only key a client has, and it is all they should need: no
 * account, no login, no app. That makes this the one query in the system that
 * runs for a stranger, so it reads exactly what the page needs and nothing
 * else. The user's phone number, their email, their bank details and their
 * other clients are not in the select list, and cannot be leaked by a template
 * that renders more than it meant to.
 */

import { db } from "../db/pool.ts";
import type { Civil } from "../../core/dates.ts";
import { partsFor, nextPayable, type Part } from "./parts.ts";

export type PublicStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "overdue"
  | "part_paid"
  | "paid"
  | "cancelled"
  | "accepted"
  | "converted"
  | "expired";

export type PublicDocument = {
  id: string;
  userId: string;
  type: "invoice" | "quote" | "payment_request" | "sample";
  number: number;
  status: PublicStatus;
  /** Whose business is billing. The only thing about the user a client sees. */
  businessName: string;
  clientName: string;
  lines: { description: string; qty: number; unitAmountKobo: number; amountKobo: number }[];
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  passFeesToClient: boolean;
  dueDate: Civil | null;
  issueDate: Civil | null;
  notes: string | null;
  /** Where the user's share settles. Absent means the page cannot take money. */
  subAccountCode: string | null;
  plan: "free" | "pro";
  /** F7: empty for an ordinary invoice, two or more for a deposit. */
  parts: Part[];
};

const civil = (d: Date | null): Civil | null =>
  d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null;

export async function findByToken(token: string): Promise<PublicDocument | null> {
  // A token is 32 hex characters from a CSPRNG. Checking the shape first means
  // a scanner probing /i/admin never reaches the database at all.
  if (!/^[0-9a-f]{32}$/.test(token)) return null;

  const { rows } = await db().query<{
    id: string;
    user_id: string;
    type: PublicDocument["type"];
    number: number;
    status: PublicStatus;
    subtotal_kobo: number;
    vat_kobo: number;
    total_kobo: number;
    amount_paid_kobo: number;
    pass_fees_to_client: boolean;
    due_date: Date | null;
    valid_until: Date | null;
    issue_date: Date | null;
    notes: string | null;
    business_name: string | null;
    plan: "free" | "pro";
    client_name: string;
    sub_account_code: string | null;
  }>(
    `SELECT d.id, d.user_id, d.type, d.number, d.status,
            d.subtotal_kobo, d.vat_kobo, d.total_kobo, d.amount_paid_kobo,
            d.pass_fees_to_client, d.due_date, d.valid_until, d.issue_date, d.notes,
            u.business_name, u.plan,
            c.name AS client_name,
            b.subaccount_code AS sub_account_code
       FROM documents d
       JOIN users u   ON u.id = d.user_id
       JOIN clients c ON c.id = d.client_id
       -- The account in force now, not one scheduled for tomorrow: F17's
       -- 24-hour delay is only a delay if every payment path honours it.
       LEFT JOIN bank_accounts b
              ON b.user_id = d.user_id
             AND b.status = 'active'
             AND (b.effective_at IS NULL OR b.effective_at <= now())
      WHERE d.public_token = $1 AND d.status <> 'draft'
      LIMIT 1`,
    [token],
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
    [r.id],
  );

  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    number: r.number,
    status: r.status,
    businessName: r.business_name ?? "A Balans user",
    clientName: r.client_name,
    lines: items.map((i) => ({
      description: i.description,
      qty: Number(i.qty),
      unitAmountKobo: i.unit_amount_kobo,
      amountKobo: i.amount_kobo,
    })),
    subtotalKobo: r.subtotal_kobo,
    vatKobo: r.vat_kobo,
    totalKobo: r.total_kobo,
    amountPaidKobo: r.amount_paid_kobo,
    passFeesToClient: r.pass_fees_to_client,
    dueDate: civil(r.due_date ?? r.valid_until),
    issueDate: civil(r.issue_date),
    notes: r.notes,
    subAccountCode: r.sub_account_code,
    plan: r.plan,
    parts: await partsFor(r.id),
  };
}

/**
 * Records the first time a client opened the page (section 6).
 *
 * Only `sent` moves to `viewed`. An overdue or part-paid document that gets
 * opened again must not travel backwards, and a paid one certainly must not.
 */
export async function markViewed(id: string): Promise<void> {
  await db().query(
    `UPDATE documents
        SET status = 'viewed', viewed_at = COALESCE(viewed_at, now())
      WHERE id = $1 AND status = 'sent'`,
    [id],
  );
}

/** What is still owed on the whole document. */
export const outstandingKobo = (d: PublicDocument): number =>
  Math.max(0, d.totalKobo - d.amountPaidKobo);

/**
 * What the Pay button charges (F7).
 *
 * The next unpaid part when the document has parts, the whole balance
 * otherwise. Only the next one: a client who could pay the balance first
 * would leave the user chasing the deposit, which is the opposite of why
 * somebody asks for a deposit.
 */
export function payableNowKobo(d: PublicDocument): number {
  if (!d.parts.length) return outstandingKobo(d);
  const next = nextPayable(d.parts);
  return next ? next.amountKobo : 0;
}

/** The label for that button, so the client knows which part they are paying. */
export const payableLabel = (d: PublicDocument): string | null =>
  d.parts.length ? (nextPayable(d.parts)?.label ?? null) : null;

/** Whether the page should show a Pay button at all. */
export function payable(d: PublicDocument): { ok: true } | { ok: false; why: string } {
  if (d.type === "quote") return { ok: false, why: "quote" };
  if (d.type === "sample") return { ok: false, why: "sample" };
  if (d.status === "cancelled") return { ok: false, why: "cancelled" };
  if (d.status === "paid" || outstandingKobo(d) === 0) return { ok: false, why: "paid" };
  // Every part settled but the document not yet marked paid: nothing to take.
  if (d.parts.length && payableNowKobo(d) === 0) return { ok: false, why: "paid" };
  // Without a subaccount the money has nowhere to settle but our own wallet,
  // which is the one thing Balans must never do.
  if (!d.subAccountCode) return { ok: false, why: "no_account" };
  return { ok: true };
}
