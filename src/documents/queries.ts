/**
 * Reading the books (PRD F14, F15).
 *
 * "Who owes me?", "has Zenith paid?", "how did I do this month?" — the three
 * questions a freelancer actually has, and the reason to open the chat when
 * they are not invoicing anybody.
 *
 * Every figure here is computed in SQL, in integer kobo, from the documents
 * themselves. Nothing is cached and nothing is kept as a running total: a
 * balance that disagrees with the invoices it came from is worse than a slow
 * query, and these are small tables per user.
 */

import { db } from "../db/pool.ts";
import { GRACE_DAYS } from "../billing/subscription.ts";
import { formatISO, type Civil } from "../../core/dates.ts";
import type { Period } from "../../core/period.ts";

/**
 * Statuses where money is still owed.
 *
 * Drafts are not owed — nobody has seen them. Cancelled ones are not owed.
 * Quotes are never owed: they are an offer, not a bill, which is why the type
 * filter matters as much as the status one.
 */
const OWING = ["sent", "viewed", "overdue", "part_paid"] as const;
const BILLABLE = ["invoice", "payment_request"] as const;

/* -------------------------------------------------------------------------- */
/* F14: who owes me                                                           */
/* -------------------------------------------------------------------------- */

export type Debt = {
  number: number | null;
  clientName: string;
  outstandingKobo: number;
  dueDate: Civil | null;
  /** Negative until due, positive once late. Null when there is no due date. */
  daysLate: number | null;
  status: string;
};

export type Debtors = {
  rows: Debt[];
  totalKobo: number;
  /** How many were left out of `rows`, which is capped for one message. */
  more: number;
  moreKobo: number;
};

/** F14: at most 10 lines, then "and N more". */
const DEBTOR_LIMIT = 10;

export async function debtors(userId: string, today: Civil): Promise<Debtors> {
  const { rows } = await db().query<{
    number: number | null;
    client_name: string;
    outstanding: number;
    due_date: Date | null;
    days_late: string | null;
    status: string;
  }>(
    `SELECT d.number,
            c.name AS client_name,
            (d.total_kobo - d.amount_paid_kobo) AS outstanding,
            d.due_date,
            ($2::date - d.due_date) AS days_late,
            d.status
       FROM documents d
       JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1
        AND d.status = ANY($3)
        AND d.type = ANY($4)
        AND d.total_kobo > d.amount_paid_kobo
      -- Oldest debt first: the one most worth chasing leads the list, and it
      -- is also the one that falls off the end if there are too many.
      ORDER BY d.due_date NULLS LAST, d.created_at`,
    [userId, formatISO(today), OWING as unknown as string[], BILLABLE as unknown as string[]],
  );

  const all: Debt[] = rows.map((r) => ({
    number: r.number,
    clientName: r.client_name,
    outstandingKobo: r.outstanding,
    dueDate: r.due_date ? civil(r.due_date) : null,
    daysLate: r.days_late === null ? null : Number(r.days_late),
    status: r.status,
  }));

  const shown = all.slice(0, DEBTOR_LIMIT);
  const rest = all.slice(DEBTOR_LIMIT);

  return {
    rows: shown,
    totalKobo: all.reduce((t, d) => t + d.outstandingKobo, 0),
    more: rest.length,
    moreKobo: rest.reduce((t, d) => t + d.outstandingKobo, 0),
  };
}

/** F14's buckets. The boundaries are the PRD's, not invented here. */
export type Bucket = "not_due" | "late_1_7" | "late_8_30" | "late_30_plus";

export function bucketOf(d: Debt): Bucket {
  if (d.daysLate === null || d.daysLate <= 0) return "not_due";
  if (d.daysLate <= 7) return "late_1_7";
  if (d.daysLate <= 30) return "late_8_30";
  return "late_30_plus";
}

/* -------------------------------------------------------------------------- */
/* F14: has X paid?                                                           */
/* -------------------------------------------------------------------------- */

export type DocumentStatus = {
  number: number | null;
  type: string;
  clientName: string;
  status: string;
  totalKobo: number;
  paidKobo: number;
  dueDate: Civil | null;
  /** The most recent thing that happened, for the "last activity" line. */
  sentAt: Date | null;
  viewedAt: Date | null;
  paidAt: Date | null;
  publicToken: string | null;
};

/**
 * Finds the document somebody is asking about.
 *
 * By number when they gave one, otherwise the most recent for a named client.
 * "Has Zenith paid?" means the last thing they were billed, which is almost
 * always the one being chased.
 */
export async function findDocument(
  userId: string,
  by: { number?: number | null; clientName?: string | null },
): Promise<DocumentStatus | null> {
  const where = by.number
    ? `d.number = $2 AND d.type = ANY($3)`
    : `lower(btrim(c.name)) LIKE '%' || lower(btrim($2)) || '%'`;

  const params: unknown[] = by.number
    ? [userId, by.number, BILLABLE as unknown as string[]]
    : [userId, by.clientName ?? ""];

  const { rows } = await db().query<{
    number: number | null;
    type: string;
    client_name: string;
    status: string;
    total_kobo: number;
    amount_paid_kobo: number;
    due_date: Date | null;
    valid_until: Date | null;
    sent_at: Date | null;
    viewed_at: Date | null;
    paid_at: Date | null;
    public_token: string | null;
  }>(
    `SELECT d.number, d.type, c.name AS client_name, d.status,
            d.total_kobo, d.amount_paid_kobo, d.due_date, d.valid_until,
            d.sent_at, d.viewed_at, d.paid_at, d.public_token
       FROM documents d
       JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.status <> 'draft' AND ${where}
      ORDER BY d.created_at DESC
      LIMIT 1`,
    params,
  );

  const r = rows[0];
  if (!r) return null;

  return {
    number: r.number,
    type: r.type,
    clientName: r.client_name,
    status: r.status,
    totalKobo: r.total_kobo,
    paidKobo: r.amount_paid_kobo,
    dueDate: r.due_date ? civil(r.due_date) : r.valid_until ? civil(r.valid_until) : null,
    sentAt: r.sent_at,
    viewedAt: r.viewed_at,
    paidAt: r.paid_at,
    publicToken: r.public_token,
  };
}

/* -------------------------------------------------------------------------- */
/* F15: how did I do                                                          */
/* -------------------------------------------------------------------------- */

export type Summary = {
  period: Period;
  /** Everything billed in the period, whether or not it was paid. */
  invoicedKobo: number;
  documents: number;
  /** Paid through Balans. Offline payments arrive in v1.1 and are separate. */
  paidKobo: number;
  /** Still owed on documents issued in the period. */
  outstandingKobo: number;
  /** Of that, how much is past its due date. */
  overdueKobo: number;
  topClients: { name: string; paidKobo: number }[];
};

export async function summarise(
  userId: string,
  period: Period,
  today: Civil,
): Promise<Summary> {
  const from = formatISO(period.from);
  const to = formatISO(period.to);
  const now = formatISO(today);

  const { rows } = await db().query<{
    invoiced: string;
    documents: string;
    paid: string;
    outstanding: string;
    overdue: string;
  }>(
    // issue_date, not created_at: a document belongs to the month it was
    // issued in, which is the date printed on it and the one a client would
    // reconcile against.
    `SELECT COALESCE(SUM(total_kobo), 0)                         AS invoiced,
            COUNT(*)                                             AS documents,
            COALESCE(SUM(amount_paid_kobo), 0)                   AS paid,
            COALESCE(SUM(total_kobo - amount_paid_kobo), 0)      AS outstanding,
            COALESCE(SUM(CASE WHEN due_date < $4::date
                               AND total_kobo > amount_paid_kobo
                              THEN total_kobo - amount_paid_kobo ELSE 0 END), 0) AS overdue
       FROM documents
      WHERE user_id = $1
        AND type = ANY($5)
        AND status <> 'draft' AND status <> 'cancelled'
        AND issue_date BETWEEN $2::date AND $3::date`,
    [userId, from, to, now, BILLABLE as unknown as string[]],
  );

  const t = rows[0]!;

  const { rows: top } = await db().query<{ name: string; paid: number }>(
    `SELECT c.name, SUM(d.amount_paid_kobo) AS paid
       FROM documents d
       JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1
        AND d.type = ANY($4)
        AND d.status <> 'draft' AND d.status <> 'cancelled'
        AND d.issue_date BETWEEN $2::date AND $3::date
        AND d.amount_paid_kobo > 0
      GROUP BY c.name
      ORDER BY paid DESC
      LIMIT 3`,
    [userId, from, to, BILLABLE as unknown as string[]],
  );

  return {
    period,
    invoicedKobo: Number(t.invoiced),
    documents: Number(t.documents),
    paidKobo: Number(t.paid),
    outstandingKobo: Number(t.outstanding),
    overdueKobo: Number(t.overdue),
    topClients: top.map((c) => ({ name: c.name, paidKobo: Number(c.paid) })),
  };
}

/* -------------------------------------------------------------------------- */
/* Plan limits (F6)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How many documents count against this month's allowance.
 *
 * Quotes count (F5). Samples do not (F2). Cancelled ones do not — somebody
 * who made a mistake and cancelled it should not lose a slot for the month.
 * Drafts do not, because the limit is checked before the draft is shown and
 * counting the one being made would be off by one.
 */
/**
 * How many documents this user has ever actually sent.
 *
 * Used to stop offering something after the first couple of invoices. Drafts
 * and cancelled documents do not count, because neither reached a client, and
 * samples are ours rather than theirs.
 */
export async function documentsEverSent(userId: string): Promise<number> {
  const { rows } = await db().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM documents
      WHERE user_id = $1
        AND type <> 'sample'
        AND status <> 'draft' AND status <> 'cancelled'`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function documentsThisMonth(userId: string, today: Civil): Promise<number> {
  const from = formatISO({ ...today, d: 1 });
  const { rows } = await db().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM documents
      WHERE user_id = $1
        AND type <> 'sample'
        AND status <> 'draft' AND status <> 'cancelled'
        AND issue_date >= $2::date`,
    [userId, from],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * What plan somebody is on, counting the grace period.
 *
 * The grace days are the point of this function reading a date at all. F18
 * gives a lapsed subscription a week before anything is taken away, and
 * `stateOf` in the billing code honours it — but this one did not, so the two
 * gave different answers for those seven days. Billing believed they were
 * still Pro while the features they had paid for were already gone: the logo
 * row vanished from settings, the document limit dropped to the free one, and
 * the renewal reminder invited them to keep a subscription that had visibly
 * already stopped working.
 *
 * A null expiry still means no expiry, which is what a subscription looks
 * like between being activated and its first period end.
 */
export async function planOf(userId: string): Promise<"free" | "pro"> {
  const { rows } = await db().query<{ plan: "free" | "pro"; expired: boolean }>(
    `SELECT plan,
            (plan_expires_at IS NOT NULL
             AND plan_expires_at < now() - ($2 || ' days')::interval) AS expired
       FROM users WHERE id = $1`,
    [userId, String(GRACE_DAYS)],
  );
  const r = rows[0];
  if (!r) return "free";
  // An expired subscription is the free plan, whatever the column says.
  return r.expired ? "free" : r.plan;
}

/* -------------------------------------------------------------------------- */

const civil = (d: Date): Civil => ({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
