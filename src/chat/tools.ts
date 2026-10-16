/**
 * What the assistant can look up, and nothing else.
 *
 * Every tool here is a read, scoped to one user by an id the model never
 * sees or chooses: it is closed over when the tools are built, so no
 * argument the model writes can reach somebody else's books. There is no
 * write. Sending, cancelling, marking paid and changing settings stay on the
 * scripted path with its confirm buttons, and the assistant can only offer
 * those buttons (see `ACTIONS` in assistant.ts).
 *
 * Every figure is worked out here, in SQL and integer kobo, and handed over
 * already formatted. The model copies "₦45,000"; it never adds anything up.
 * Same rule as the parser: a total a language model computed is a total
 * nobody should send to a client.
 */

import { db } from "../db/pool.ts";
import { formatFriendly, formatISO, nearDay, todayIn, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { readPeriod } from "../../core/period.ts";
import { documentsThisMonth, planOf, summarise } from "../documents/queries.ts";
import { defaults } from "../config.ts";
import { GRACE_DAYS } from "../billing/subscription.ts";
import { TEMPLATES } from "../pdf/templates.ts";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_documents",
    description:
      "The user's invoices, quotes and payment requests, newest first, at most 15, with totals for the whole filtered set worked out for you. Use it for who owes what, what a client has been billed or has paid, what is late, and what was sent recently. It has no line items: for what a document was for, use get_document.",
    input_schema: {
      type: "object",
      properties: {
        which: {
          type: "string",
          enum: ["owed", "overdue", "paid", "recent", "quotes", "cancelled"],
          description: "owed: still unpaid. overdue: unpaid and past the due date. paid: fully paid. recent: everything sent. quotes: quotes only. cancelled: cancelled ones.",
        },
        client: { type: "string", description: "Part of a client's name, to narrow to one client. Leave out for all clients." },
      },
      required: ["which"],
      additionalProperties: false,
    },
  },
  {
    name: "get_document",
    description:
      "One invoice, quote or payment request by its number: line items, payment plan, payments received, reminders sent, and whether the client has opened it.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "The document number, e.g. 4 for invoice #4." },
        type: { type: "string", enum: ["invoice", "quote", "payment_request"], description: "Defaults to invoice." },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "money_summary",
    description:
      "Totals for a period: invoiced, received, still owed, overdue, and the top paying clients. Pass the period in the user's own words.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: 'In words, e.g. "this month", "last month", "this week", "March", "this year", "last year". Never a computed date.',
        },
      },
      required: ["period"],
      additionalProperties: false,
    },
  },
  {
    name: "get_account",
    description:
      "The user's own account: business name, plan and when Pro ends (grace week included), how many documents they have used this month, payout bank, email, logo, signature, invoice design and default due days.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type RunTool = (name: string, input: unknown) => Promise<unknown>;

/** The tools for one user. The id is closed over here and nowhere else. */
export function toolsFor(userId: string, today: Civil): RunTool {
  return async (name, input) => {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    switch (name) {
      case "list_documents":
        return listDocuments(userId, today, String(args.which ?? "recent"), typeof args.client === "string" ? args.client : null);
      case "get_document":
        return getDocument(userId, today, Number(args.number), typeof args.type === "string" ? args.type : "invoice");
      case "money_summary":
        return moneySummary(userId, today, String(args.period ?? "this month"));
      case "get_account":
        return getAccount(userId, today);
      default:
        return { error: `There is no tool called ${name}.` };
    }
  };
}

/**
 * What most questions need, fetched before the model is asked anything.
 *
 * Each lookup the model asks for is another round trip to it, a second and a
 * half or two each, and "why has Tunde not paid?" used to take two. This is a
 * few milliseconds of SQL, so most answers now take one call. The tools stay
 * for what this leaves out: a document's items, its reminders, other periods.
 */
export async function snapshot(userId: string, today: Civil) {
  const [account, owed, recent, thisMonth] = await Promise.all([
    getAccount(userId, today),
    listDocuments(userId, today, "owed", null),
    listDocuments(userId, today, "recent", null),
    moneySummary(userId, today, "this month"),
  ]);
  return { account, owed, recent, this_month: thisMonth };
}

/* -------------------------------------------------------------------------- */

const money = (kobo: number | string | null | undefined): string => formatNaira(Number(kobo ?? 0));
/**
 * Dates written out, weekday and all, so the model never works one out: asked
 * for the weekday of 7 October 2026 it said Monday, and it was a Wednesday.
 * And "today", "tomorrow" or "yesterday" written in, so a deadline a day away
 * is said that way: "Sat, 17 Oct (tomorrow)".
 *
 * A moment is read in Lagos. A DATE column arrives as midnight on the server,
 * which is already the day it names.
 */
const when = (today: Civil) => (d: Date | null): string | null => {
  if (!d) return null;
  const dateOnly = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  const c = dateOnly
    ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
    : todayIn(defaults.behaviour.timezone, d);
  const near = nearDay(c, today);
  return `${formatFriendly(c, today)}${near ? ` (${near})` : ""}`;
};

const WHICH: Record<string, string> = {
  owed: `d.type IN ('invoice', 'payment_request') AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid') AND d.total_kobo > d.amount_paid_kobo`,
  overdue: `d.type IN ('invoice', 'payment_request') AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid') AND d.total_kobo > d.amount_paid_kobo AND d.due_date < $3::date`,
  paid: `d.type IN ('invoice', 'payment_request') AND d.status = 'paid'`,
  recent: `d.status NOT IN ('draft', 'cancelled')`,
  quotes: `d.type = 'quote' AND d.status <> 'draft'`,
  cancelled: `d.status = 'cancelled'`,
};

async function listDocuments(userId: string, today: Civil, which: string, client: string | null) {
  const day = when(today);
  const filter = WHICH[which] ?? WHICH.recent!;
  const params = [userId, client ?? "", formatISO(today)];
  /*
   * `$3::date IS NOT NULL` is there so every query names all three
   * parameters. Only "owed" and "overdue" use today's date in the filter, and
   * Postgres refuses a parameter a query never mentions ("could not determine
   * data type of parameter $3") — which failed the totals for "recent" and
   * "paid", and with them the snapshot sent with every question, from launch
   * until 14 October 2026. The assistant answered "I couldn't reach your
   * invoice records".
   */
  const base = `FROM documents d JOIN clients c ON c.id = d.client_id
     WHERE d.user_id = $1 AND $3::date IS NOT NULL AND d.type <> 'sample' AND ${filter}
       AND ($2 = '' OR lower(c.name) LIKE '%' || lower(btrim($2)) || '%')`;

  const [{ rows }, { rows: sums }] = await Promise.all([
    db().query<{
      number: number; type: string; client: string; status: string; title: string | null;
      total_kobo: string; paid_kobo: string; issue_date: Date | null; due_date: Date | null;
      viewed_at: Date | null; days_late: number | null;
    }>(
      `SELECT d.number, d.type, c.name AS client, d.status, d.title,
              d.total_kobo, d.amount_paid_kobo AS paid_kobo, d.issue_date, d.due_date, d.viewed_at,
              CASE WHEN d.due_date IS NOT NULL THEN ($3::date - d.due_date) END AS days_late
         ${base}
        ORDER BY d.created_at DESC
        LIMIT 15`,
      params,
    ),
    db().query<{ n: string; total: string; paid: string; owed: string }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(d.total_kobo), 0) AS total,
              COALESCE(SUM(d.amount_paid_kobo), 0) AS paid,
              COALESCE(SUM(d.total_kobo - d.amount_paid_kobo), 0) AS owed
         ${base}`,
      params,
    ),
  ]);

  const s = sums[0]!;
  return {
    which,
    client: client || "all clients",
    count: Number(s.n),
    shown: rows.length,
    totals: { billed: money(s.total), paid: money(s.paid), still_owed: which === "quotes" ? undefined : money(s.owed) },
    documents: rows.map((r) => ({
      ref: `${r.type === "quote" ? "Quote" : r.type === "payment_request" ? "Request" : "Invoice"} #${r.number}`,
      client: r.client,
      ...(r.title ? { title: r.title } : {}),
      status: r.status,
      total: money(r.total_kobo),
      paid: money(r.paid_kobo),
      still_owed: money(Number(r.total_kobo) - Number(r.paid_kobo)),
      issued: day(r.issue_date),
      due: day(r.due_date),
      ...(r.days_late != null && r.days_late > 0 && Number(r.total_kobo) > Number(r.paid_kobo) ? { days_late: r.days_late } : {}),
      opened_by_client: Boolean(r.viewed_at),
    })),
  };
}

async function getDocument(userId: string, today: Civil, number: number, type: string) {
  const day = when(today);
  if (!Number.isInteger(number) || number < 1) return { error: "That is not a document number." };
  const kind = ["invoice", "quote", "payment_request"].includes(type) ? type : "invoice";

  const { rows } = await db().query<{
    id: string; number: number; type: string; status: string; title: string | null; client: string;
    client_email: string | null; currency: string; subtotal_kobo: string; vat_kobo: string; total_kobo: string;
    paid_kobo: string; issue_date: Date | null; due_date: Date | null; valid_until: Date | null;
    sent_at: Date | null; viewed_at: Date | null; paid_at: Date | null; cancelled_at: Date | null; notes: string | null;
  }>(
    `SELECT d.id, d.number, d.type, d.status, d.title, c.name AS client, c.email AS client_email, d.currency,
            d.subtotal_kobo, d.vat_kobo, d.total_kobo, d.amount_paid_kobo AS paid_kobo,
            d.issue_date, d.due_date, d.valid_until, d.sent_at, d.viewed_at, d.paid_at, d.cancelled_at, d.notes
       FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.number = $2 AND d.type = $3 AND d.status <> 'draft'`,
    [userId, number, kind],
  );
  const d = rows[0];
  if (!d) return { error: `There is no ${kind.replace("_", " ")} #${number} on this account.` };

  const [lines, parts, payments, reminders] = await Promise.all([
    db().query<{ description: string; qty: string; amount_kobo: string }>(
      `SELECT description, qty, amount_kobo FROM line_items WHERE document_id = $1 ORDER BY position`,
      [d.id],
    ),
    db().query<{ label: string; amount_kobo: string; status: string; paid_at: Date | null }>(
      `SELECT label, amount_kobo, status, paid_at FROM payment_parts WHERE document_id = $1 ORDER BY position`,
      [d.id],
    ),
    db().query<{ amount_kobo: string; created_at: Date; channel: string | null }>(
      `SELECT amount_kobo, created_at, channel FROM payments
        WHERE document_id = $1 AND status = 'success'
        ORDER BY created_at`,
      [d.id],
    ),
    db().query<{ kind: string; channel: string; sent_at: Date | null }>(
      `SELECT kind, channel, sent_at FROM reminders WHERE document_id = $1 AND status = 'sent' ORDER BY sent_at`,
      [d.id],
    ),
  ]);

  const owed = Number(d.total_kobo) - Number(d.paid_kobo);
  return {
    ref: `${kind === "quote" ? "Quote" : kind === "payment_request" ? "Request" : "Invoice"} #${d.number}`,
    client: d.client,
    client_has_email: Boolean(d.client_email),
    ...(d.title ? { title: d.title } : {}),
    status: d.status,
    ...(d.currency !== "NGN" ? { currency: d.currency, note: "Amounts below are the naira equivalent." } : {}),
    lines: lines.rows.map((l) => ({ description: l.description, qty: Number(l.qty), amount: money(l.amount_kobo) })),
    subtotal: money(d.subtotal_kobo),
    ...(Number(d.vat_kobo) > 0 ? { vat: money(d.vat_kobo) } : {}),
    total: money(d.total_kobo),
    paid: money(d.paid_kobo),
    still_owed: money(owed),
    issued: day(d.issue_date),
    due: day(d.due_date ?? d.valid_until),
    ...(d.due_date && owed > 0 ? { days_late: Math.max(0, daysBetween(d.due_date, today)) } : {}),
    sent: day(d.sent_at),
    opened_by_client: day(d.viewed_at) ?? false,
    fully_paid_on: day(d.paid_at),
    cancelled_on: day(d.cancelled_at),
    ...(d.notes ? { notes: d.notes } : {}),
    payment_plan: parts.rows.map((p) => ({ part: p.label, amount: money(p.amount_kobo), status: p.status, paid_on: day(p.paid_at) })),
    payments_received: payments.rows.map((p) => ({ amount: money(p.amount_kobo), on: day(p.created_at), by: p.channel })),
    reminders_sent: reminders.rows.map((r) => ({
      which: r.kind === "due" ? "on the due date" : r.kind === "late_3" ? "3 days late" : r.kind === "late_7" ? "7 days late" : r.kind,
      by: r.channel,
      on: day(r.sent_at),
    })),
  };
}

async function moneySummary(userId: string, today: Civil, words: string) {
  const period = readPeriod(words, today);
  if (!period) return { error: `I could not read "${words}" as a period. Try "this month", "last month", "March" or "this year".` };
  const s = await summarise(userId, period, today);
  return {
    period: period.label,
    from: formatFriendly(period.from, today),
    to: formatFriendly(period.to, today),
    documents: s.documents,
    invoiced: money(s.invoicedKobo),
    received: money(s.paidKobo),
    still_owed: money(s.outstandingKobo),
    of_which_overdue: money(s.overdueKobo),
    top_paying_clients: s.topClients.map((c) => ({ client: c.name, paid: money(c.paidKobo) })),
    note: "Counts documents issued in the period. Payments the user marked paid themselves are included.",
  };
}

async function getAccount(userId: string, today: Civil) {
  const day = when(today);
  const [{ rows }, plan, used, { rows: banks }] = await Promise.all([
    db().query<{
      business_name: string | null; email: string | null; email_verified_at: Date | null; plan_expires_at: Date | null;
      logo_url: string | null; signature_url: string | null; template_id: string | null; default_due_days: number; created_at: Date;
    }>(
      `SELECT business_name, email, email_verified_at, plan_expires_at, logo_url, signature_url, template_id,
              default_due_days, created_at
         FROM users WHERE id = $1`,
      [userId],
    ),
    planOf(userId),
    documentsThisMonth(userId, today),
    db().query<{ bank_name: string; account_last4: string; account_name: string; status: string; effective_at: Date | null }>(
      `SELECT bank_name, account_last4, account_name, status, effective_at FROM bank_accounts
        WHERE user_id = $1 AND status IN ('active', 'pending') ORDER BY status`,
      [userId],
    ),
  ]);
  const u = rows[0];
  if (!u) return { error: "No account." };
  const limit = defaults.plans[plan].documentsPerMonth;
  const active = banks.find((x) => x.status === "active");
  const pending = banks.find((x) => x.status === "pending");
  return {
    business_name: u.business_name,
    plan,
    ...proDates(plan, u.plan_expires_at, day),
    documents_this_month: used,
    monthly_limit: limit ?? "unlimited",
    // Worked out here: asked how many were left, the model said "2 of 3"
    // rather than subtract, which is the rule doing its job.
    documents_left_this_month: limit == null ? "unlimited" : Math.max(0, limit - used),
    payout_account: active ? `${active.bank_name} ····${active.account_last4} (${active.account_name})` : "none set",
    ...(pending ? { payout_change_pending: `${pending.bank_name} ····${pending.account_last4}, takes effect ${day(pending.effective_at)}` } : {}),
    email: u.email ? (u.email_verified_at ? "set and verified" : "set, not verified") : "none",
    logo: Boolean(u.logo_url),
    signature: Boolean(u.signature_url),
    invoice_design: TEMPLATES.find((t) => t.id === u.template_id)?.name ?? "Classic",
    default_due_days: u.default_due_days,
    member_since: day(u.created_at),
  };
}

/**
 * When Pro ends, grace week included.
 *
 * A Pro month that has run out keeps every Pro feature for a week more. The
 * assistant was given only the month's end, and told somebody whose Pro
 * features ran to 17 October that Pro ended on 10 October (16 October 2026).
 */
function proDates(plan: string, expires: Date | null, day: (d: Date | null) => string | null) {
  if (plan !== "pro" || !expires) return {};
  const graceEnds = new Date(expires.getTime() + GRACE_DAYS * 86_400_000);
  if (Date.now() <= expires.getTime()) {
    return {
      pro_paid_until: day(expires),
      if_not_renewed: `Pro features carry on for a ${GRACE_DAYS}-day grace week, until ${day(graceEnds)}, then the account moves to Free.`,
    };
  }
  return {
    pro_paid_until: `${day(expires)}, already passed`,
    in_grace_week: true,
    pro_features_stop: `${day(graceEnds)}, unless they renew. Then the account moves to Free.`,
  };
}

function daysBetween(from: Date, to: Civil): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.y, to.m - 1, to.d);
  return Math.round((b - a) / 86_400_000);
}
