/**
 * The draft summary (PRD F6 step 2).
 *
 * "Bot replies with one summary: client, amount in full (350,000),
 * description, due date, options. Asks 'Send it?'"
 *
 * One message, because it is one decision. The total is the thing being
 * approved, so the total is what carries the bold — everything else is there
 * to be scanned, not read.
 */

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { b, block, lines, para, row } from "../whatsapp/format.ts";
import type { Draft } from "./store.ts";

/** F6: description defaults to "Services" if absent, and the draft says so. */
export const DEFAULT_DESCRIPTION = "Services";

const LABEL: Record<Draft["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Payment request",
  sample: "Sample invoice",
};

/** F8: a request is numbered in the invoice sequence and reads like one. */
const SENT_LABEL: Record<Draft["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Request",
  sample: "Sample",
};

export function draftSummary(draft: Draft, today: Civil): string {
  const rows: (string | false)[] = [row("Client", draft.clientName)];

  // One line reads as a single "Work" row. Several deserve their own lines,
  // because the itemisation is the part a client queries.
  if (draft.lines.length === 1) {
    const only = draft.lines[0]!;
    rows.push(row("Work", `${only.description}${only.qty === 1 ? "" : ` x${only.qty}`}`));
  } else {
    rows.push("Work:");
    for (const line of draft.lines) {
      const each = line.qty === 1 ? "" : ` x${line.qty}`;
      rows.push(`  · ${line.description}${each} — ${formatNaira(line.unitAmountKobo * line.qty)}`);
    }
  }

  // Subtotal only when VAT makes it differ from the total: showing the same
  // number twice is noise on the one line somebody is checking.
  if (draft.vatKobo > 0) {
    rows.push(row("Subtotal", formatNaira(draft.subtotalKobo)));
    rows.push(row(`VAT ${draft.vatPercent}%`, formatNaira(draft.vatKobo)));
  }

  rows.push(row("Amount", b(formatNaira(draft.totalKobo))));

  if (draft.dueDate) {
    rows.push(row(draft.type === "quote" ? "Valid until" : "Due", formatFriendly(draft.dueDate, today)));
  }
  if (draft.depositPercent) rows.push(row("Deposit", `${draft.depositPercent}% up front`));
  if (draft.instalments) {
    // The figure, not just the count. "3 payments" leaves somebody working out
    // what each one is worth, and this is the line they check before sending.
    rows.push(
      row("Payments", `${draft.instalments} x ${formatNaira(Math.round(draft.totalKobo / draft.instalments))}`),
    );
  }
  if (draft.passFeesToClient) rows.push(row("Fees", "Client pays the transaction fee"));
  if (draft.clientEmail) rows.push(row("Email to", draft.clientEmail));

  // Just the question. The three answers arrive as buttons under it, so
  // spelling them out here would print the instructions twice.
  return para(block(`🧾 ${b(`${LABEL[draft.type].toUpperCase()} DRAFT`)}`, rows), b("Send it?"));
}


/**
 * The three answers to "Send it?".
 *
 * Ids are the words the parser already reads, so a tap and a typed reply take
 * exactly the same path through the machine and neither needs a special case.
 */
export const draftButtons = (): { id: string; title: string }[] => [
  { id: "yes", title: "✅ Send it" },
  { id: "change something", title: "✏️ Change it" },
  { id: "no", title: "🗑️ Discard" },
];

/**
 * What to say when one thing is missing (F6 step 1, F3's "ask for that one
 * thing only").
 *
 * One question, never a list. Somebody who gets three questions at once
 * answers one of them and the bot has to ask the other two anyway.
 */
export function askFor(missing: string, draft: { clientName?: string }): string {
  switch (missing) {
    case "client_name":
      return lines(`👤 ${b("Who is this for?")}`, "Just the name is fine.");
    case "amount":
      return draft.clientName
        ? lines(
            `💰 ${b(`How much is ${draft.clientName} paying?`)}`,
            `You can write it like ${b("350k")}.`,
          )
        : lines(`💰 ${b("How much is it for?")}`, `You can write it like ${b("350k")}.`);
    case "description":
      return lines(
        `📝 ${b("What is it for?")}`,
        `A few words is enough — or reply ${b("skip")} and it will say "${DEFAULT_DESCRIPTION}".`,
      );
    case "due_date":
      return lines(
        `📅 ${b("When is it due?")}`,
        `Try ${b("Friday")}, ${b("month end")}, or ${b("30 days")}.`,
      );
    default:
      return `💬 ${b("Tell me a bit more and I will draft it.")}`;
  }
}

/**
 * What goes out once a document is confirmed (F6 step 4).
 *
 * Two messages, and the split is the point. The first is written for the
 * *client*: it carries the PDF and says "click the link to pay", so the user
 * can forward it exactly as it arrived without editing anything out. The
 * second is a private note to the user, which would read as nonsense to a
 * client and must not be part of what they forward.
 *
 * It costs one extra message. Worth it: a message that has to be retyped
 * before it can be sent is a message that does not get sent.
 */
export function sentMessage(
  draft: Draft,
  confirmed: { number: number; publicToken: string },
  baseUrl: string,
  today: Civil,
): { forward: string; note: string } {
  const label = SENT_LABEL[draft.type];
  const link = `${baseUrl.replace(/\/$/, "")}/i/${confirmed.publicToken}`;

  const note =
    draft.type === "quote"
      ? `Reply ${b(`convert quote ${confirmed.number}`)} when they accept.`
      : "I will tell you the moment it is paid.";

  /*
   * The note travels in the caption, not in a message of its own.
   *
   * It used to follow as a second bubble so that nothing the user forwarded
   * carried it — the caption goes wherever the PDF goes, and "I will tell you
   * when it is paid" is addressed to the sender, not the client.
   *
   * From 1 October every outbound message is charged, and that separation
   * costs ₦14.50 on every invoice ever sent. A client reading one line meant
   * for somebody else is a smaller problem than a quarter of the send cost, so
   * the note is set below a rule where it plainly belongs to the sender.
   */
  const forward = para(
    block(`✅ ${b(`${label.toUpperCase()} #${confirmed.number}`)}`, [
      row("Client", draft.clientName),
      row("Amount", b(formatNaira(draft.totalKobo))),
      draft.dueDate &&
        row(draft.type === "quote" ? "Valid until" : "Due", formatFriendly(draft.dueDate, today)),
    ]),
    lines(draft.type === "quote" ? "Click the link to view it:" : "Click the link to pay:", link),
    note,
  );

  return { forward, note };
}
