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
import { b, lines, para } from "../whatsapp/format.ts";
import type { Draft } from "./store.ts";

/** F6: description defaults to "Services" if absent, and the draft says so. */
export const DEFAULT_DESCRIPTION = "Services";

const LABEL: Record<Draft["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Payment request",
  sample: "Sample invoice",
};

export function draftSummary(draft: Draft, today: Civil): string {
  const head = `🧾 ${LABEL[draft.type]} for ${b(draft.clientName)}`;

  const body: string[] = [];

  // One line item reads better inline; several deserve a list with their own
  // amounts, because that is the part a client will query.
  if (draft.lines.length === 1) {
    const only = draft.lines[0]!;
    body.push(`${only.description}${only.qty === 1 ? "" : ` x${only.qty}`}`);
  } else {
    for (const line of draft.lines) {
      const each = line.qty === 1 ? "" : ` x${line.qty}`;
      body.push(`· ${line.description}${each} — ${formatNaira(line.unitAmountKobo * line.qty)}`);
    }
  }

  // Subtotal only when it differs from the total, so a plain invoice shows one
  // number and not the same number twice.
  const money: string[] = [];
  if (draft.vatKobo > 0) {
    money.push(`Subtotal: ${formatNaira(draft.subtotalKobo)}`);
    money.push(`VAT ${draft.vatPercent}%: ${formatNaira(draft.vatKobo)}`);
  }
  money.push(`Total: ${b(formatNaira(draft.totalKobo))}`);

  const terms: string[] = [];
  if (draft.dueDate) {
    // A quote does not fall due; it stops being good.
    const word = draft.type === "quote" ? "Valid until" : "Due";
    terms.push(`${word} ${formatFriendly(draft.dueDate, today)}`);
  }
  if (draft.depositPercent) {
    terms.push(`${draft.depositPercent}% deposit up front`);
  }
  if (draft.passFeesToClient) {
    terms.push("Client pays the transaction fee");
  }
  if (draft.clientEmail) {
    terms.push(`Copy to ${draft.clientEmail}`);
  }

  return para(
    lines(head, ...body),
    lines(...money),
    terms.length ? lines(...terms) : "",
    `${b("Send it?")} Reply yes, or tell me what to change.`,
  );
}

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
        b("What is it for?"),
        `A few words is enough — or reply ${b("skip")} and it will say "${DEFAULT_DESCRIPTION}".`,
      );
    case "due_date":
      return lines(
        `📅 ${b("When is it due?")}`,
        `Try ${b("Friday")}, ${b("month end")}, or ${b("30 days")}.`,
      );
    default:
      return b("Tell me a bit more and I will draft it.");
  }
}

/** F6 step 4: one message with the link, ready to forward. */
export function sentMessage(
  draft: Draft,
  confirmed: { number: number; publicToken: string },
  baseUrl: string,
  today: Civil,
): string {
  const label = draft.type === "quote" ? "Quote" : "Invoice";
  const link = `${baseUrl.replace(/\/$/, "")}/i/${confirmed.publicToken}`;

  return para(
    `✅ ${label} ${b(`#${confirmed.number}`)} is ready.`,
    lines(
      `${draft.clientName} — ${formatNaira(draft.totalKobo)}`,
      draft.dueDate
        ? `${draft.type === "quote" ? "Valid until" : "Due"} ${formatFriendly(draft.dueDate, today)}`
        : "",
    ),
    lines("Send this to them:", link),
    draft.type === "quote"
      ? `Reply ${b(`convert quote ${confirmed.number}`)} when they accept.`
      : `I will tell you the moment it is paid.`,
  );
}
