/**
 * The month as a statement, by email (1 November 2026).
 *
 * The summary in the chat is four figures and three names, which is what a
 * phone screen holds. The statement is the rest, laid out the way people
 * already read money: a bank statement. What was owed at the start, what was
 * invoiced, what came in, what is owed at the end, and every line behind
 * those four, so a figure in the chat can be checked against a list.
 *
 * Asked for with "Email my statement" under the summary on the 1st, or typed
 * any time ("email my statement", "statement for September"). It goes to the
 * confirmed email only: it lists every client and every amount, and an
 * unconfirmed address may be a typo, which would send it to a stranger.
 *
 * The opening and closing figures come from the payments themselves, as they
 * stood on each date, so the four always add up:
 *
 *   owed at the start + invoiced - received = owed at the end
 *
 * A cancelled invoice is left out of every figure, as everywhere else, and a
 * quote is not money anybody owes.
 */

import type { FastifyBaseLogger } from "fastify";

import { addDays, compare, formatISO, type Civil } from "../../core/dates.ts";
import { previousMonth, type Period } from "../../core/period.ts";
import { formatNaira } from "../../core/totals.ts";
import { formatMoney, type Currency } from "../../core/currency.ts";
import { defaults } from "../config.ts";
import { db } from "../db/pool.ts";
import { sendEmail, statementEmail } from "../email/send.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPdf } from "../pdf/chrome.ts";
import { COIN, CREAM, INK, MARIGOLD, ink, methodWords } from "../pdf/kit.ts";
import { esc } from "./page.ts";

const BILLABLE = ["invoice", "payment_request"];

// prettier-ignore
const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type StatementLine = {
  issueDate: Civil;
  number: number | null;
  type: string;
  clientName: string;
  what: string | null;
  dueDate: Civil | null;
  totalKobo: number;
  /** Paid against it by the end of the period. */
  paidKobo: number;
  currency: string;
  originalMinor: number | null;
};

export type StatementPayment = {
  date: Civil;
  clientName: string;
  number: number | null;
  type: string;
  method: string;
  amountKobo: number;
};

export type Statement = {
  businessName: string;
  period: Period;
  /** The last day the figures count, today if the month is not over. */
  asOf: Civil;
  generated: Civil;
  openingKobo: number;
  invoicedKobo: number;
  receivedKobo: number;
  closingKobo: number;
  /** Of the closing figure, what was past its due date on `asOf`. */
  overdueKobo: number;
  documents: StatementLine[];
  payments: StatementPayment[];
  topInvoiced: { name: string; kobo: number; count: number }[];
  topPaid: { name: string; kobo: number }[];
  owing: { clientName: string; number: number | null; type: string; outstandingKobo: number; dueDate: Civil | null }[];
  /** Days from issue to paid in full, for invoices settled this period. */
  avgDaysToPay: number | null;
  /** Of what was invoiced this period, the share already paid by `asOf`. */
  collectedShare: number | null;
  previous: { label: string; receivedKobo: number; invoicedKobo: number };
};

const civil = (d: Date | string): Civil => {
  const s = typeof d === "string" ? d : d.toISOString();
  const [y, m, day] = s.slice(0, 10).split("-").map(Number);
  return { y: y!, m: m!, d: day! };
};

const n = (v: string | number | null | undefined): number => Number(v ?? 0);

/** The figures for one period, from the database. Null for an unknown user. */
export async function statementFor(userId: string, period: Period, today: Civil): Promise<Statement | null> {
  const tz = defaults.behaviour.timezone;
  const asOf = compare(period.to, today) > 0 ? today : period.to;
  const from = formatISO(period.from);
  const to = formatISO(asOf);

  const { rows: who } = await db().query<{ business_name: string | null }>(
    `SELECT business_name FROM users WHERE id = $1`,
    [userId],
  );
  if (!who.length) return null;

  /*
   * Paid against a document by the end of a day: from the payments, not
   * amount_paid_kobo, which only knows today. invoice_amount_kobo is what a
   * payment settles; the rest of a charge is a fee the client paid on top.
   */
  const paidBy = (day: string) => `COALESCE((
      SELECT SUM(COALESCE(p.invoice_amount_kobo, p.amount_kobo)) FROM payments p
       WHERE p.document_id = d.id AND p.status = 'success'
         AND (COALESCE(p.paid_at, p.created_at) AT TIME ZONE '${tz}')::date <= ${day}::date), 0)`;

  const { rows: bal } = await db().query<{ opening: string; closing: string; overdue: string }>(
    `SELECT
       COALESCE(SUM(GREATEST(d.total_kobo - ${paidBy("($2::date - 1)")}, 0))
         FILTER (WHERE d.issue_date < $2::date), 0)                                  AS opening,
       COALESCE(SUM(GREATEST(d.total_kobo - ${paidBy("$3")}, 0)), 0)                AS closing,
       COALESCE(SUM(GREATEST(d.total_kobo - ${paidBy("$3")}, 0))
         FILTER (WHERE d.due_date < $3::date), 0)                                    AS overdue
       FROM documents d
      WHERE d.user_id = $1 AND d.type::text = ANY($4)
        AND d.status <> 'draft' AND d.status <> 'cancelled'
        AND d.issue_date <= $3::date`,
    [userId, from, to, BILLABLE],
  );

  const { rows: docs } = await db().query<{
    issue_date: string;
    number: number | null;
    type: string;
    client: string | null;
    what: string | null;
    due_date: string | null;
    total_kobo: string;
    paid: string;
    currency: string;
    original_amount_minor: string | null;
  }>(
    `SELECT d.issue_date::text, d.number, d.type::text, c.name AS client,
            COALESCE(d.title, (SELECT li.description FROM line_items li
                                WHERE li.document_id = d.id ORDER BY li.position LIMIT 1)) AS what,
            d.due_date::text, d.total_kobo, ${paidBy("$3")} AS paid,
            d.currency, d.original_amount_minor
       FROM documents d
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.type::text = ANY($4)
        AND d.status <> 'draft' AND d.status <> 'cancelled'
        AND d.issue_date BETWEEN $2::date AND $3::date
      ORDER BY d.issue_date, d.number NULLS LAST`,
    [userId, from, to, BILLABLE],
  );

  const { rows: pays } = await db().query<{
    day: string;
    client: string | null;
    number: number | null;
    type: string;
    channel: string | null;
    method: string;
    amount: string;
  }>(
    `SELECT (COALESCE(p.paid_at, p.created_at) AT TIME ZONE '${tz}')::date::text AS day,
            c.name AS client, d.number, d.type::text, p.channel, p.method::text,
            COALESCE(p.invoice_amount_kobo, p.amount_kobo) AS amount
       FROM payments p
       JOIN documents d ON d.id = p.document_id
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.type::text = ANY($4)
        AND d.status <> 'draft' AND d.status <> 'cancelled'
        AND p.status = 'success'
        AND (COALESCE(p.paid_at, p.created_at) AT TIME ZONE '${tz}')::date BETWEEN $2::date AND $3::date
      ORDER BY COALESCE(p.paid_at, p.created_at)`,
    [userId, from, to, BILLABLE],
  );

  // Owed at the end, by document, worst first.
  const { rows: owing } = await db().query<{
    client: string | null;
    number: number | null;
    type: string;
    due_date: string | null;
    outstanding: string;
  }>(
    `SELECT * FROM (
       SELECT c.name AS client, d.number, d.type::text, d.due_date::text,
              d.total_kobo - ${paidBy("$2")} AS outstanding
         FROM documents d
         LEFT JOIN clients c ON c.id = d.client_id
        WHERE d.user_id = $1 AND d.type::text = ANY($3)
          AND d.status <> 'draft' AND d.status <> 'cancelled'
          AND d.issue_date <= $2::date
     ) o
     WHERE o.outstanding > 0
     ORDER BY o.due_date NULLS LAST, o.outstanding DESC`,
    [userId, to, BILLABLE],
  );

  // Fully paid this period: how long it took, from the day it was issued.
  const { rows: speed } = await db().query<{ days: string | null }>(
    `SELECT AVG(settled - d.issue_date)::numeric(10,1) AS days
       FROM documents d
       JOIN LATERAL (
         SELECT (MAX(COALESCE(p.paid_at, p.created_at)) AT TIME ZONE '${tz}')::date AS settled
           FROM payments p WHERE p.document_id = d.id AND p.status = 'success'
       ) s ON true
      WHERE d.user_id = $1 AND d.type::text = ANY($4)
        AND d.status <> 'draft' AND d.status <> 'cancelled'
        AND d.amount_paid_kobo >= d.total_kobo AND d.total_kobo > 0
        AND s.settled BETWEEN $2::date AND $3::date`,
    [userId, from, to, BILLABLE],
  );

  const prev = previousMonth(period.from);
  const { rows: before } = await db().query<{ invoiced: string; received: string }>(
    `SELECT
       (SELECT COALESCE(SUM(d.total_kobo), 0) FROM documents d
         WHERE d.user_id = $1 AND d.type::text = ANY($4)
           AND d.status <> 'draft' AND d.status <> 'cancelled'
           AND d.issue_date BETWEEN $2::date AND $3::date) AS invoiced,
       (SELECT COALESCE(SUM(COALESCE(p.invoice_amount_kobo, p.amount_kobo)), 0)
          FROM payments p JOIN documents d ON d.id = p.document_id
         WHERE d.user_id = $1 AND d.type::text = ANY($4)
           AND d.status <> 'draft' AND d.status <> 'cancelled' AND p.status = 'success'
           AND (COALESCE(p.paid_at, p.created_at) AT TIME ZONE '${tz}')::date BETWEEN $2::date AND $3::date) AS received`,
    [userId, formatISO(prev.from), formatISO(prev.to), BILLABLE],
  );

  const documents: StatementLine[] = docs.map((d) => ({
    issueDate: civil(d.issue_date),
    number: d.number,
    type: d.type,
    clientName: d.client ?? "No client",
    what: d.what,
    dueDate: d.due_date ? civil(d.due_date) : null,
    totalKobo: n(d.total_kobo),
    paidKobo: n(d.paid),
    currency: d.currency,
    originalMinor: d.original_amount_minor === null ? null : n(d.original_amount_minor),
  }));
  const payments: StatementPayment[] = pays.map((p) => ({
    date: civil(p.day),
    clientName: p.client ?? "No client",
    number: p.number,
    type: p.type,
    method: p.method === "offline" ? "Marked paid" : methodWords(p.channel),
    amountKobo: n(p.amount),
  }));

  const invoicedKobo = documents.reduce((t, d) => t + d.totalKobo, 0);
  const receivedKobo = payments.reduce((t, p) => t + p.amountKobo, 0);
  const collected = documents.reduce((t, d) => t + Math.min(d.paidKobo, d.totalKobo), 0);

  return {
    businessName: who[0]!.business_name?.trim() || "Your business",
    period,
    asOf,
    generated: today,
    openingKobo: n(bal[0]?.opening),
    invoicedKobo,
    receivedKobo,
    closingKobo: n(bal[0]?.closing),
    overdueKobo: n(bal[0]?.overdue),
    documents,
    payments,
    topInvoiced: rank(documents.map((d) => [d.clientName, d.totalKobo] as const)).map(([name, kobo, count]) => ({
      name,
      kobo,
      count,
    })),
    topPaid: rank(payments.map((p) => [p.clientName, p.amountKobo] as const)).map(([name, kobo]) => ({ name, kobo })),
    owing: owing.map((o) => ({
      clientName: o.client ?? "No client",
      number: o.number,
      type: o.type,
      outstandingKobo: n(o.outstanding),
      dueDate: o.due_date ? civil(o.due_date) : null,
    })),
    avgDaysToPay: speed[0]?.days === null || speed[0]?.days === undefined ? null : Number(speed[0].days),
    collectedShare: invoicedKobo > 0 ? collected / invoicedKobo : null,
    previous: { label: prev.label, invoicedKobo: n(before[0]?.invoiced), receivedKobo: n(before[0]?.received) },
  };
}

/** Clients by total, biggest first, with how many entries made it up. Five at most. */
function rank(rows: readonly (readonly [string, number])[]): [string, number, number][] {
  const by = new Map<string, [number, number]>();
  for (const [name, kobo] of rows) {
    const had = by.get(name) ?? [0, 0];
    by.set(name, [had[0] + kobo, had[1] + 1]);
  }
  return [...by.entries()]
    .map(([name, [kobo, count]]) => [name, kobo, count] as [string, number, number])
    .filter(([, kobo]) => kobo > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

/* -------------------------------------------------------------------------- */
/* The sheet                                                                  */
/* -------------------------------------------------------------------------- */

const day = (c: Civil): string => `${c.d} ${SHORT[c.m - 1]}`;
const longDay = (c: Civil): string => `${c.d} ${MONTHS[c.m - 1]} ${c.y}`;
const money = (kobo: number): string => esc(formatNaira(kobo));
const ref = (type: string, number: number | null): string =>
  number === null ? "—" : `${type === "payment_request" ? "Request" : "Invoice"} #${number}`;
const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** "▲ 24% on September", or nothing when there is nothing to compare with. */
function versus(now: number, before: number, label: string): string {
  if (before <= 0) return "";
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return `Same as ${label}`;
  return `${change > 0 ? "▲" : "▼"} ${pct(Math.abs(change))} on ${label}`;
}

function statusOf(d: StatementLine, asOf: Civil): { word: string; cls: string } {
  if (d.paidKobo >= d.totalKobo && d.totalKobo > 0) return { word: "Paid", cls: "paid" };
  if (d.paidKobo > 0) return { word: "Part paid", cls: "part" };
  if (d.dueDate && compare(d.dueDate, asOf) < 0) return { word: "Overdue", cls: "late" };
  return { word: "Unpaid", cls: "" };
}

function clientTable(title: string, rows: { name: string; kobo: number; note: string }[], total: number): string {
  if (!rows.length) return "";
  return `<div class="rank"><h3>${title}</h3>${rows
    .map(
      (r, i) => `<div class="rk"><span class="ri">${i + 1}</span><span class="rn">${esc(r.name)}<small>${esc(r.note)}</small></span>
<span class="rv">${money(r.kobo)}<small>${total > 0 ? pct(r.kobo / total) : ""}</small></span></div>`,
    )
    .join("")}</div>`;
}

/**
 * A titled table. The title is the first row of the header, which Chrome
 * repeats on every page and never leaves alone at the foot of one: a heading
 * stranded under its own page break was the first thing a long month did.
 * The total is the last row of the body, printed once.
 */
function section(title: string, total: string, head: string[], body: string, foot: string, empty: string): string {
  const cols = head.length;
  const th = head.map((h) => `<th${/^(Amount|Owed|Paid)$/.test(h) ? ' class="n"' : ""}>${h}</th>`).join("");
  return `<table class="sec"><thead><tr><th colspan="${cols}" class="h2"><span>${title}</span><span class="tot">${total}</span></th></tr>
${body ? `<tr>${th}</tr>` : ""}</thead>
<tbody>${body ? body + foot.replace("<tr>", '<tr class="total">') : `<tr><td colspan="${cols}" class="none">${empty}</td></tr>`}</tbody></table>`;
}

export function statementHtml(s: Statement): string {
  const monthName = MONTHS[s.period.from.m - 1]!;
  const span = `${longDay(s.period.from)} to ${longDay(s.asOf)}`;
  const partial = compare(s.asOf, s.period.to) < 0;

  const docRows = s.documents
    .map((d) => {
      const st = statusOf(d, s.asOf);
      const foreign =
        d.currency !== "NGN" && d.originalMinor !== null
          ? `<small>${esc(formatMoney(d.originalMinor, d.currency as Currency))}</small>`
          : "";
      return `<tr><td>${day(d.issueDate)}</td><td>${ref(d.type, d.number)}</td>
<td>${esc(d.clientName)}${d.what ? `<small>${esc(d.what)}</small>` : ""}</td>
<td>${d.dueDate ? day(d.dueDate) : "—"}</td><td class="n">${money(d.totalKobo)}${foreign}</td>
<td class="n">${d.paidKobo ? money(d.paidKobo) : "—"}</td><td><span class="st ${st.cls}">${st.word}</span></td></tr>`;
    })
    .join("");

  const payRows = s.payments
    .map(
      (p) => `<tr><td>${day(p.date)}</td><td>${esc(p.clientName)}</td><td>${ref(p.type, p.number)}</td>
<td>${esc(p.method)}</td><td class="n in">+${money(p.amountKobo)}</td></tr>`,
    )
    .join("");

  const owingRows = s.owing
    .map((o) => {
      const late = o.dueDate && compare(o.dueDate, s.asOf) < 0;
      const days = o.dueDate ? Math.round((Date.UTC(s.asOf.y, s.asOf.m - 1, s.asOf.d) - Date.UTC(o.dueDate.y, o.dueDate.m - 1, o.dueDate.d)) / 86_400_000) : 0;
      return `<tr><td>${esc(o.clientName)}</td><td>${ref(o.type, o.number)}</td><td>${o.dueDate ? day(o.dueDate) : "—"}</td>
<td>${late ? `<span class="st late">${days} ${days === 1 ? "day" : "days"} late</span>` : "Not due yet"}</td><td class="n">${money(o.outstandingKobo)}</td></tr>`;
    })
    .join("");

  const facts: [string, string][] = [];
  if (s.collectedShare !== null) facts.push(["Collected", `${pct(s.collectedShare)} of what you invoiced in ${monthName}`]);
  if (s.avgDaysToPay !== null) facts.push(["Time to get paid", `${s.avgDaysToPay % 1 === 0 ? s.avgDaysToPay : s.avgDaysToPay.toFixed(1)} days on average`]);
  const biggest = [...s.documents].sort((a, b) => b.totalKobo - a.totalKobo)[0];
  if (biggest) facts.push(["Biggest invoice", `${formatNaira(biggest.totalKobo)}, ${biggest.clientName}`]);
  const vsIn = versus(s.receivedKobo, s.previous.receivedKobo, s.previous.label);
  if (vsIn) facts.push(["Money in", vsIn]);
  const vsBilled = versus(s.invoicedKobo, s.previous.invoicedKobo, s.previous.label);
  if (vsBilled) facts.push(["Invoiced", vsBilled]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
${fontFaces(["brand"])}
@page{size:A4;margin:14mm 0 16mm}
@page:first{margin-top:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${FONT.brand};color:${INK};font-size:9.4pt;line-height:1.45;-webkit-font-smoothing:antialiased;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{background:${INK};color:${CREAM};padding:15mm 16mm 12mm;display:flex;justify-content:space-between;align-items:flex-end}
.brand{display:flex;align-items:center;gap:8px;font-size:12pt;font-weight:500;letter-spacing:-.01em;margin-bottom:9mm}
.brand svg{width:22px;height:22px}
.top h1{font-size:25pt;font-weight:400;letter-spacing:-.03em;line-height:1.05}
.top .who{font-size:10.5pt;color:rgba(246,241,231,.72);margin-top:2mm}
.top .meta{text-align:right;font-size:8.6pt;color:rgba(246,241,231,.62);line-height:1.6}
.top .meta b{color:${CREAM};font-weight:500}
.wrap{padding:8mm 16mm 0}
.bal{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid ${ink(0.12)};border-radius:10px;overflow:hidden}
.bal div{padding:4.5mm 4.5mm 4mm;border-left:1px solid ${ink(0.1)}}
.bal div:first-child{border-left:0}
.bal .k{font-size:7.6pt;text-transform:uppercase;letter-spacing:.08em;color:${ink(0.55)}}
.bal .v{font-size:14pt;font-weight:500;letter-spacing:-.02em;margin-top:1.5mm;white-space:nowrap}
.bal .s{font-size:7.8pt;color:${ink(0.55)};margin-top:.5mm}
.bal .hi{background:#FFF6DC}
.eq{font-size:8pt;color:${ink(0.5)};margin:2.5mm 0 0 1mm}
h2{font-size:11.5pt;font-weight:500;letter-spacing:-.01em;margin:9mm 0 3mm;display:flex;justify-content:space-between;align-items:baseline}
h2 span{font-size:8.6pt;font-weight:400;color:${ink(0.55)}}
table{width:100%;border-collapse:collapse}
.sec{margin-top:9mm}
th.h2{font-size:11.5pt;font-weight:500;letter-spacing:-.01em;text-transform:none;color:${INK};padding:0 0 3mm;border-bottom:0}
th.h2 span{display:inline-block}
th.h2 .tot{float:right;font-size:8.6pt;font-weight:400;color:${ink(0.55)};padding-top:1mm}
thead{display:table-header-group}
tr{break-inside:avoid}
th{font-size:7.4pt;text-transform:uppercase;letter-spacing:.07em;color:${ink(0.55)};font-weight:500;text-align:left;
  padding:0 2mm 2mm;border-bottom:1px solid ${ink(0.2)}}
td{padding:2.4mm 2mm;border-bottom:1px solid ${ink(0.08)};vertical-align:top}
td small{display:block;font-size:7.8pt;color:${ink(0.5)};margin-top:.3mm}
.n{text-align:right;white-space:nowrap}
th.n{text-align:right}
.in{color:#2F7A4B;font-weight:500}
/* In the body, not a tfoot: Chrome repeats a tfoot on every page. */
.total td{font-weight:500;border-bottom:0;border-top:1px solid ${ink(0.2)}}
.st{display:inline-block;font-size:7.6pt;padding:.4mm 2mm;border-radius:99px;background:${ink(0.06)};white-space:nowrap}
.st.paid{background:#E3F1E8;color:#2F7A4B}.st.part{background:#FFF1CC;color:#8A6200}.st.late{background:#F9E3DD;color:#B5482F}
.none{color:${ink(0.5)};padding:3mm 0;border-bottom:1px solid ${ink(0.08)}}
.ranks{display:grid;grid-template-columns:1fr 1fr;gap:6mm}
.rank h3{font-size:8pt;text-transform:uppercase;letter-spacing:.07em;color:${ink(0.55)};font-weight:500;padding-bottom:2mm;border-bottom:1px solid ${ink(0.2)}}
.rk{display:flex;align-items:flex-start;gap:3mm;padding:2.4mm 0;border-bottom:1px solid ${ink(0.08)}}
.ri{width:5mm;height:5mm;border-radius:99px;background:${MARIGOLD};font-size:7.4pt;font-weight:500;display:flex;align-items:center;justify-content:center;flex:none}
.rn{flex:1}.rv{text-align:right;white-space:nowrap;font-weight:500}
.rk small{display:block;font-weight:400;font-size:7.8pt;color:${ink(0.5)}}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:0 6mm}
.facts div{display:flex;justify-content:space-between;gap:4mm;padding:2.4mm 0;border-bottom:1px solid ${ink(0.08)}}
.facts .k{color:${ink(0.55)}}.facts .v{font-weight:500;text-align:right}
.foot{margin:10mm 0 0;padding-top:4mm;border-top:1px solid ${ink(0.12)};font-size:7.6pt;color:${ink(0.5)};line-height:1.6}
</style></head><body>
<div class="top">
  <div>
    <div class="brand">${COIN}Balans</div>
    <h1>${esc(monthName)} statement</h1>
    <p class="who">${esc(s.businessName)}</p>
  </div>
  <div class="meta">${esc(span)}${partial ? "<br>Month to date" : ""}<br>Made <b>${esc(longDay(s.generated))}</b></div>
</div>
<div class="wrap">

<div class="bal">
  <div><p class="k">Owed at the start</p><p class="v">${money(s.openingKobo)}</p><p class="s">${esc(longDay(addDays(s.period.from, -1)))}</p></div>
  <div><p class="k">Invoiced</p><p class="v">${money(s.invoicedKobo)}</p><p class="s">${s.documents.length} ${s.documents.length === 1 ? "invoice" : "invoices"}</p></div>
  <div class="hi"><p class="k">Money in</p><p class="v">${money(s.receivedKobo)}</p><p class="s">${s.payments.length} ${s.payments.length === 1 ? "payment" : "payments"}</p></div>
  <div><p class="k">Owed at the end</p><p class="v">${money(s.closingKobo)}</p><p class="s">${s.overdueKobo > 0 ? `${money(s.overdueKobo)} overdue` : esc(longDay(s.asOf))}</p></div>
</div>
<p class="eq">Owed at the start + invoiced − money in = owed at the end</p>

${facts.length ? `<h2>At a glance</h2><div class="facts">${facts.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>` : ""}

${
  s.topInvoiced.length || s.topPaid.length
    ? `<h2>Your clients</h2><div class="ranks">
${clientTable("Most invoiced", s.topInvoiced.map((c) => ({ name: c.name, kobo: c.kobo, note: `${c.count} ${c.count === 1 ? "invoice" : "invoices"}` })), s.invoicedKobo)}
${clientTable("Paid you most", s.topPaid.map((c) => ({ name: c.name, kobo: c.kobo, note: "" })), s.receivedKobo)}
</div>`
    : ""
}

${section(
  "Money in",
  `+${money(s.receivedKobo)}`,
  ["Date", "Client", "For", "How", "Amount"],
  payRows,
  `<tr><td colspan="4">Total</td><td class="n in">+${money(s.receivedKobo)}</td></tr>`,
  `No payments came in during ${esc(monthName)}.`,
)}

${section(
  "Invoices issued",
  money(s.invoicedKobo),
  ["Date", "Number", "Client", "Due", "Amount", "Paid", "Status"],
  docRows,
  `<tr><td colspan="4">Total</td><td class="n">${money(s.invoicedKobo)}</td><td class="n">${money(s.documents.reduce((t, d) => t + d.paidKobo, 0))}</td><td></td></tr>`,
  `No invoices were issued in ${esc(monthName)}.`,
)}

${section(
  `Still owed on ${esc(longDay(s.asOf))}`,
  money(s.closingKobo),
  ["Client", "Number", "Due", "Status", "Owed"],
  owingRows,
  "",
  "Nothing. Every invoice is paid.",
)}

<p class="foot">Amounts in naira. An invoice in another currency counts at the naira amount on it, with the original under it.
Cancelled invoices and quotes are not included. Payments marked paid by you are counted on the day you marked them.<br>
Balans is not a bank and never holds your money. This statement is a record of the invoices you sent with Balans, not a bank statement.</p>
</div></body></html>`;
}

/* -------------------------------------------------------------------------- */
/* Sending it                                                                 */
/* -------------------------------------------------------------------------- */

export type StatementOutcome =
  | { kind: "sent"; email: string; period: Period }
  | { kind: "no_email" }
  | { kind: "failed" };

/** The month "email statement 2026-10" names, or the last whole month. */
export function statementPeriod(text: string, today: Civil, read: (t: string, today: Civil) => Period | null): Period {
  const m = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(text);
  if (m) return wholeMonth({ y: Number(m[1]), m: Number(m[2]), d: 1 });
  // A statement is a whole month: "this month" is the month to date, and a
  // week or a day named is the month it falls in. A bare ask is the month
  // just gone.
  const said = read(text, today);
  return said ? wholeMonth(said.from) : wholeMonth(previousMonth(today).from);
}

/** The month a day falls in, named by the month: "October". */
export function wholeMonth(c: Civil): Period {
  const from: Civil = { y: c.y, m: c.m, d: 1 };
  return { ...previousMonth(addMonthsCivil(from, 1)), label: MONTHS[c.m - 1]! };
}

const addMonthsCivil = (c: Civil, by: number): Civil => {
  const i = c.y * 12 + (c.m - 1) + by;
  return { y: Math.floor(i / 12), m: (i % 12) + 1, d: 1 };
};

/** Builds the PDF and emails it to the confirmed address. Never throws. */
export async function emailStatement(
  userId: string,
  period: Period,
  today: Civil,
  log: FastifyBaseLogger,
): Promise<StatementOutcome> {
  try {
    const { rows } = await db().query<{ email: string | null; verified: boolean }>(
      `SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1`,
      [userId],
    );
    const to = rows[0]?.verified ? rows[0].email : null;
    if (!to) return { kind: "no_email" };

    const s = await statementFor(userId, period, today);
    if (!s) return { kind: "failed" };

    const pdf = await renderPdf(statementHtml(s));
    const monthName = MONTHS[period.from.m - 1]!;
    const filename = `Balans statement ${monthName} ${period.from.y}.pdf`;
    const sent = await sendEmail(
      {
        to,
        ...statementEmail({
          businessName: s.businessName,
          month: `${monthName} ${period.from.y}`,
          received: formatNaira(s.receivedKobo),
          invoiced: formatNaira(s.invoicedKobo),
          owed: formatNaira(s.closingKobo),
          payments: s.payments.length,
          invoices: s.documents.length,
        }),
        attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
      },
      log,
    );
    if (!sent.ok) {
      log.error({ userId, reason: sent.reason }, "statement email not sent");
      return { kind: "failed" };
    }
    log.info({ userId, period: period.label, bytes: pdf.length }, "statement emailed");
    return { kind: "sent", email: to, period };
  } catch (e) {
    log.error({ userId, err: (e as Error).message }, "could not make the statement");
    return { kind: "failed" };
  }
}
