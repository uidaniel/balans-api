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
import { b, block, BULLET, i, lines, para, row } from "../whatsapp/format.ts";
import { bucketOf, type Bucket, type Debtors, type DocumentStatus, type Summary } from "./queries.ts";
import { payBy } from "./summary.ts";
import type { BankDetails } from "./bank-details.ts";
import type { CancelPreview } from "./actions.ts";
import { formatMoney, type Currency } from "../../core/currency.ts";

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
          return `${BULLET}${r.clientName}${num} — ${formatNaira(r.outstandingKobo)} (${when})`;
        }),
      ),
    );
  }

  const tail =
    d.more > 0
      ? `and ${b(`${d.more} more`)} worth ${formatNaira(d.moreKobo)}. Reply ${b("dashboard")} to see all.`
      : "";

  // A one-row block would be a heading over a single line, which reads as
  // heavy. The total belongs in the title here, and the blank line `para`
  // leaves after it separates it from the groups underneath.
  return para(
    `⏳ ${b("OWED TO YOU")} — ${b(formatNaira(d.totalKobo))}`,
    ...groups,
    tail,
  );
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
    row("Paid", b(formatNaira(s.paidKobo))),
    row("Invoiced", `${formatNaira(s.invoicedKobo)} across ${s.documents}`),
  ];
  if (s.outstandingKobo > 0) body.push(row("Outstanding", formatNaira(s.outstandingKobo)));
  if (s.overdueKobo > 0) body.push(row("Overdue", formatNaira(s.overdueKobo)));

  const top = s.topClients.length
    ? lines(
        s.topClients.length === 1 ? "Best client:" : "Best clients:",
        ...s.topClients.map((c) => `${BULLET}${c.name} — ${formatNaira(c.paidKobo)}`),
      )
    : "";

  // The headline is what landed, not what was billed: money in the bank is
  // the number people actually want.
  return para(
    block(`💰 ${b(s.period.label.toUpperCase())}`, body),
    top,
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The trial is used up (19 October 2026): three sent documents, ever, and
 * the next one needs Pro. There is no reset date to name any more.
 *
 * The words-only version, used when the card cannot be sent. It has to carry
 * the offer itself, because there is no picture behind it and no button under
 * it — so it says what to reply.
 */
export function limitReachedMessage(allowance: number, perMonth: string | null = null): string {
  return para(
    `🛑 ${b(`You have used your ${allowance} free documents.`)}`,
    perMonth
      ? `Reply ${b("upgrade")} to keep sending invoices, from ${perMonth} a month on the yearly plan.`
      : `Reply ${b("upgrade")} to keep sending invoices, monthly or yearly.`,
    i("Invoices already sent still work, and you still get paid."),
  );
}

/**
 * The same thing, under the Pro card.
 *
 * Shorter, because the card above it already says what Pro is and the
 * button under it says how to start. What is left is the part the picture
 * cannot know, and that nothing already sent is affected: somebody stopped
 * mid-invoice will wonder whether money they are owed is at risk.
 */
export function limitReachedCaption(allowance: number, perMonth: string | null = null): string {
  return para(
    `🛑 ${b(`You have used your ${allowance} free documents.`)}`,
    perMonth
      ? `Get Pro to keep sending invoices, from ${perMonth} a month on the yearly plan.`
      : "Get Pro to keep sending invoices, monthly or yearly.",
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
  if (why === "paying_now") {
    return lines(
      `⏳ ${b(`Invoice #${number}`)} cannot be cancelled yet. Your client has started paying it.`,
      "If the money does not come, you can cancel it a little later.",
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

/* -------------------------------------------------------------------------- */
/* Cancelling several at once (14 October 2026)                               */
/* -------------------------------------------------------------------------- */

/** Why one of a list cannot be cancelled, in the fewest plain words. */
const CANNOT_CANCEL: Record<string, string> = {
  has_payment: "paid",
  paying_now: "your client is paying it now",
  already_cancelled: "already cancelled",
  not_found: "not found",
};
const whyNot = (why: string) => CANNOT_CANCEL[why] ?? "not found";

const count = (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`);

type Cancellable = Extract<CancelPreview, { ok: true }>;
type NotCancellable = Extract<CancelPreview, { ok: false }>;

/**
 * The one question before a list is cancelled, and the buttons under it.
 *
 * Only the ones that can go are on the "yes" button's id, so a tap cannot
 * cancel something the question did not show. With nothing cancellable there
 * is nothing to confirm: it says why for each, and has no buttons. Titles are
 * kept well under Meta's twenty characters ("Yes, cancel 20" is fourteen).
 */
export function cancelManyAsk(preview: CancelPreview[]): {
  body: string;
  buttons: { id: string; title: string }[];
  yesId: string | null;
} {
  const ok = preview.filter((p): p is Cancellable => p.ok);
  const cannot = preview
    .filter((p): p is NotCancellable => !p.ok)
    .map((p) => `${BULLET}#${p.number} — ${whyNot(p.why)}`);

  if (!ok.length) {
    return {
      body: lines(`⚠️ ${b(preview.length === 1 ? "That one cannot be cancelled." : "None of those can be cancelled.")}`, ...cannot),
      buttons: [],
      yesId: null,
    };
  }

  const yesId = `yes cancel invoices ${ok.map((p) => p.number).join(" ")}`;
  const one = ok.length === 1;
  const body = para(
    lines(
      `⚠️ ${b(one ? `Cancel invoice #${ok[0]!.number}?` : `Cancel ${count(ok.length)}?`)}`,
      ...ok.map((p) => `${b(`#${p.number}`)} ${p.clientName} — ${amountOf(p)}${p.type === "quote" ? " (quote)" : ""}`),
    ),
    cannot.length ? lines("Can't cancel:", ...cannot) : null,
    `Their clients will not be reminded again and cannot pay ${one ? "it" : "them"}. This can't be undone.`,
  );
  return {
    body,
    buttons: [
      { id: yesId, title: one ? "Yes, cancel it" : `Yes, cancel ${ok.length}` },
      { id: "keep invoices", title: one ? "Keep it" : "Keep them" },
    ],
    yesId,
  };
}

function amountOf(p: Cancellable): string {
  if (p.currency !== "NGN" && p.amountMinor !== null) return formatMoney(p.amountMinor, p.currency as Currency);
  return formatNaira(p.totalKobo);
}

/** The one answer after "yes cancel invoices 3 4 6": what went, and what did not. */
export function cancelledManyMessage(done: number[], failed: { number: number; why: string }[]): string {
  const not = failed.map((f) => `${BULLET}#${f.number} — ${whyNot(f.why)}`);
  if (!done.length) {
    return lines(`⚠️ ${b("Nothing was cancelled.")}`, ...not);
  }
  return para(
    lines(
      `🚫 ${b(`Cancelled ${count(done.length)}:`)} ${done.map((n) => `#${n}`).join(", ")}`,
      `Their clients cannot pay ${done.length === 1 ? "it" : "them"} now, and the ${done.length === 1 ? "page says" : "pages say"} so.`,
    ),
    not.length ? lines("Could not cancel:", ...not) : null,
  );
}

export function resendMessage(
  d: { number: number | null; type: string; clientName: string; totalKobo: number; amountPaidKobo: number },
  link: string,
  bank: BankDetails | null = null,
): string {
  const label = d.type === "quote" ? "Quote" : "Invoice";
  const owed = d.totalKobo - d.amountPaidKobo;
  return para(
    `🔗 ${label} ${b(`#${d.number}`)} for ${d.clientName}.`,
    lines(
      owed > 0 ? `${b(formatNaira(owed))} still owed.` : b("Paid in full."),
      "Send this to them:",
      // The link either way; on a naira invoice it opens the account to pay into.
      bank ? payBy(link, bank) : link,
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
      `ℹ️ Quote ${b(`#${quoteNumber}`)} is already Invoice ${b(`#${n}`)}.`,
      `Reply ${b(`resend invoice ${n}`)} for the link.`,
    );
  }
  if (why === "cancelled") return `🚫 Quote ${b(`#${quoteNumber}`)} was cancelled.`;
  return lines(
    `🔍 I cannot find ${b(`quote ${quoteNumber}`)}.`,
    `Reply ${b("who owes me")} to see what is outstanding.`,
  );
}

export function remindersStoppedMessage(count: number, number: number | null): string {
  if (count === 0) {
    return number === null
      ? "🔕 There are no reminders left to stop. Any due have already gone out, and no more are coming."
      : `🔕 There are no reminders left to stop for ${b(`invoice #${number}`)}. Any due have already gone out, and no more are coming.`;
  }
  return number === null
    ? "🔕 Reminders are off for all your open invoices."
    : `🔕 Reminders are off for ${b(`invoice #${number}`)}.`;
}
