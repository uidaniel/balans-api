/**
 * Turning the books into one message (PRD F14, F15).
 *
 * F16 budgets these at one message each, which is the real constraint: a
 * debtors list is a wall of numbers unless it is grouped, and fifteen lines
 * on a phone is a scroll nobody finishes. So the shape is always the same —
 * the total first, then the detail under it, worst first.
 *
 * "Client-facing surfaces never use the word debtor" (F14). Neither does this
 * one: the user is not a bank, and the people who owe them are their clients.
 */

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { b, i, lines, para } from "../whatsapp/format.ts";
import { bucketOf, type Bucket, type Debtors, type DocumentStatus, type Summary } from "./queries.ts";

const BUCKET_TITLE: Record<Bucket, string> = {
  late_30_plus: "Over 30 days late",
  late_8_30: "8 to 30 days late",
  late_1_7: "1 to 7 days late",
  not_due: "Not due yet",
};

/** Worst first: the money least likely to arrive is the money to act on. */
const BUCKET_ORDER: Bucket[] = ["late_30_plus", "late_8_30", "late_1_7", "not_due"];

export function debtorsMessage(d: Debtors, today: Civil): string {
  if (!d.rows.length) {
    return lines(
      `✅ ${b("Nothing outstanding.")}`,
      "Every invoice you have sent is paid.",
    );
  }

  const groups: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    const rows = d.rows.filter((r) => bucketOf(r) === bucket);
    if (!rows.length) continue;

    const total = rows.reduce((t, r) => t + r.outstandingKobo, 0);
    groups.push(
      lines(
        `${BUCKET_TITLE[bucket]} — ${formatNaira(total)}`,
        ...rows.map((r) => {
          const when = r.dueDate ? formatFriendly(r.dueDate, today) : "no date";
          const num = r.number === null ? "" : ` #${r.number}`;
          return `· ${r.clientName}${num} — ${formatNaira(r.outstandingKobo)} (${when})`;
        }),
      ),
    );
  }

  const tail =
    d.more > 0
      ? `and ${b(`${d.more} more`)} worth ${formatNaira(d.moreKobo)}. Reply ${b("dashboard")} to see all.`
      : "";

  return para(`⏳ ${b(formatNaira(d.totalKobo))} owed to you.`, ...groups, tail);
}

/* -------------------------------------------------------------------------- */

export function statusMessage(
  doc: DocumentStatus,
  today: Civil,
  baseUrl: string,
): string {
  const label = doc.type === "quote" ? "Quote" : "Invoice";
  const which = doc.number === null ? label : `${label} ${b(`#${doc.number}`)}`;
  const owed = doc.totalKobo - doc.paidKobo;

  const head =
    owed <= 0
      ? `✅ ${which} — ${b("paid in full")}.`
      : doc.status === "cancelled"
        ? `🚫 ${which} was cancelled.`
        : `⏳ ${which} — ${b(formatNaira(owed))} still owed.`;

  const detail: string[] = [`${doc.clientName} — ${formatNaira(doc.totalKobo)}`];
  if (doc.paidKobo > 0 && owed > 0) detail.push(`${formatNaira(doc.paidKobo)} paid so far`);
  if (doc.dueDate && owed > 0) {
    const word = doc.type === "quote" ? "Valid until" : "Due";
    detail.push(`${word} ${formatFriendly(doc.dueDate, today)}`);
  }

  // F14 asks for the last activity. The most recent thing that happened is
  // more useful than a list of everything that did.
  const activity = lastActivity(doc);

  return para(
    head,
    lines(...detail),
    activity,
    owed > 0 && doc.publicToken ? lines("Their link:", `${baseUrl.replace(/\/$/, "")}/i/${doc.publicToken}`) : "",
  );
}

function lastActivity(doc: DocumentStatus): string {
  if (doc.paidAt) return i(`Paid ${ago(doc.paidAt)}.`);
  if (doc.viewedAt) return i(`They opened it ${ago(doc.viewedAt)}.`);
  if (doc.sentAt) return i(`Sent ${ago(doc.sentAt)}. Not opened yet.`);
  return "";
}

/** "3 days ago", in the words somebody would use out loud. */
function ago(at: Date): string {
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export function notFoundMessage(asked: { number?: number | null; clientName?: string | null }): string {
  if (asked.number) {
    return lines(
      `🔍 I cannot find ${b(`invoice ${asked.number}`)}.`,
      `Reply ${b("who owes me")} to see what is outstanding.`,
    );
  }
  if (asked.clientName) {
    return lines(
      `🔍 Nothing on file for ${b(asked.clientName)}.`,
      `Reply ${b("who owes me")} to see what is outstanding.`,
    );
  }
  return lines(
    `🔍 ${b("Which one?")}`,
    `Try ${b("status invoice 3")}, or ask ${b("has Zenith paid?")}`,
  );
}

/* -------------------------------------------------------------------------- */

export function summaryMessage(s: Summary): string {
  if (s.documents === 0) {
    return lines(
      `📊 Nothing invoiced ${s.period.label}.`,
      `Send me a line like ${b("Invoice Tunde 20k for logo")} to start.`,
    );
  }

  const body: string[] = [
    `Invoiced: ${formatNaira(s.invoicedKobo)} across ${s.documents} ${s.documents === 1 ? "document" : "documents"}`,
    `Paid: ${formatNaira(s.paidKobo)}`,
  ];
  if (s.outstandingKobo > 0) body.push(`Outstanding: ${formatNaira(s.outstandingKobo)}`);
  if (s.overdueKobo > 0) body.push(`Overdue: ${formatNaira(s.overdueKobo)}`);

  const top = s.topClients.length
    ? lines(
        s.topClients.length === 1 ? "Best client:" : "Best clients:",
        ...s.topClients.map((c) => `· ${c.name} — ${formatNaira(c.paidKobo)}`),
      )
    : "";

  // The headline is what landed, not what was billed: money in the bank is
  // the number people actually want.
  return para(
    `💰 ${b(formatNaira(s.paidKobo))} paid ${s.period.label}.`,
    lines(...body),
    top,
  );
}

/* -------------------------------------------------------------------------- */

/** F6: when the Free limit is hit, say so and offer Pro. */
export function limitReachedMessage(used: number, limit: number): string {
  return para(
    `🛑 That is your ${b(`${limit} documents`)} for this month.`,
    lines(
      `You have sent ${used}. The count resets on the 1st.`,
      `Reply ${b("upgrade")} for unlimited documents and a lower fee.`,
    ),
    i("Invoices already sent still work, and you still get paid."),
  );
}

/* -------------------------------------------------------------------------- */
/* Actions on a document that exists (F5, F6)                                 */
/* -------------------------------------------------------------------------- */

export function cancelledMessage(x: { number: number; type: string; clientName: string }): string {
  const label = x.type === "quote" ? "Quote" : "Invoice";
  return lines(
    `🚫 ${label} ${b(`#${x.number}`)} is cancelled.`,
    `${x.clientName} cannot pay it now, and the page says so.`,
  );
}

export function cannotCancelMessage(number: number, why: string): string {
  if (why === "has_payment") {
    return para(
      `⚠️ ${b(`Invoice #${number}`)} has been paid, so it cannot be cancelled.`,
      lines(
        "If the money needs to go back, that is a refund.",
        `Email ${b("hello@balans.ng")} and a person will sort it.`,
      ),
    );
  }
  if (why === "already_cancelled") {
    return `Invoice ${b(`#${number}`)} was already cancelled.`;
  }
  return lines(
    `🔍 I cannot find ${b(`invoice ${number}`)}.`,
    `Reply ${b("who owes me")} to see what is outstanding.`,
  );
}

export function resendMessage(
  d: { number: number | null; type: string; clientName: string; totalKobo: number; amountPaidKobo: number },
  link: string,
): string {
  const label = d.type === "quote" ? "Quote" : "Invoice";
  const owed = d.totalKobo - d.amountPaidKobo;
  return para(
    `🔗 ${label} ${b(`#${d.number}`)} for ${d.clientName}.`,
    lines(
      owed > 0 ? `${b(formatNaira(owed))} still owed.` : b("Paid in full."),
      "Send this to them:",
      link,
    ),
  );
}

export function convertedMessage(x: {
  invoiceNumber: number;
  quoteNumber: number;
  clientName: string;
  totalKobo: number;
}): string {
  return para(
    `✅ Quote #${x.quoteNumber} is now ${b(`Invoice #${x.invoiceNumber}`)}.`,
    lines(`${x.clientName} — ${formatNaira(x.totalKobo)}`, "The quote stays as it was."),
  );
}

export function cannotConvertMessage(quoteNumber: number, why: string): string {
  if (why.startsWith("already_converted")) {
    const n = why.split(":")[1];
    return lines(
      `Quote ${b(`#${quoteNumber}`)} is already Invoice ${b(`#${n}`)}.`,
      `Reply ${b(`resend invoice ${n}`)} for the link.`,
    );
  }
  if (why === "cancelled") return `Quote ${b(`#${quoteNumber}`)} was cancelled.`;
  return lines(
    `🔍 I cannot find ${b(`quote ${quoteNumber}`)}.`,
    `Reply ${b("who owes me")} to see what is outstanding.`,
  );
}

export function remindersStoppedMessage(count: number, number: number | null): string {
  if (count === 0) return "There were no reminders waiting to stop.";
  return number === null
    ? "🔕 Reminders are off for all your open invoices."
    : `🔕 Reminders are off for ${b(`invoice #${number}`)}.`;
}
