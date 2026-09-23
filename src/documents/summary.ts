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
import { settle } from "../../core/fees.ts";
import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { b, block, lines, para, row } from "../whatsapp/format.ts";
import { shapeFor } from "./parts.ts";
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

/**
 * The payment plan, written out, with the figure for every stage.
 *
 * One helper for every surface that shows it, and the arithmetic is
 * `splitInto` — the same call that wrote the rows in `payment_parts`. That
 * is the whole point of it being here. The draft summary used to divide the
 * total by the number of instalments itself, which agrees with the stored
 * parts right up until the division is not exact, and then the message
 * promises three payments of one figure while the client is charged another.
 *
 * "Due now" on the first stage because that is literally its status: the
 * first part is written `payable` and the rest `pending`. A client looking
 * at a deposit invoice is asking exactly one question — how much do I pay
 * today — and the total at the top is not the answer.
 */
export function planLines(draft: {
  totalKobo: number;
  depositPercent: number | null;
  instalments: number | null;
}): string[] {
  const shape = shapeFor(draft, draft.totalKobo);
  if (!shape) return [];

  return [
    "Payment plan:",
    ...shape.map(
      (p, i) => `  · ${p.label} — ${formatNaira(p.amountKobo)}${i === 0 ? " (due now)" : ""}`,
    ),
  ];
}

/**
 * What actually lands in the user's bank, once every fee has come out.
 *
 * Summed over the payment plan rather than taken off the total, because the
 * fees are charged per payment and not per invoice. A ₦50,000 invoice paid in
 * one go meets the processor's flat charge once; the same invoice split into a
 * deposit and a balance meets it twice, and the difference is real money the
 * summary would otherwise be wrong about.
 *
 * The rates are the ones `/pay` settles with — same `settle`, same defaults —
 * so this is not a second opinion that can drift from the first. If the number
 * here is wrong then the split at payment time is wrong too, and the place to
 * fix it is the rate table, not this message.
 *
 * With the fee passed to the client, the client's total is grossed up and what
 * comes out of the user's share is only our own fee. That falls out of
 * `settle`; there is no separate branch for it here.
 */
export function payout(
  draft: {
    totalKobo: number;
    depositPercent: number | null;
    instalments: number | null;
    passFeesToClient: boolean;
  },
  plan: "free" | "pro",
): { receivesKobo: number; feesKobo: number } {
  const p = defaults.plans[plan];
  const rates = { percentBps: p.feePercentBps, minKobo: p.feeMinKobo, capKobo: p.feeCapKobo };

  const shape = shapeFor(draft, draft.totalKobo);
  const payments = shape?.length ? shape.map((s) => s.amountKobo) : [draft.totalKobo];

  const receivesKobo = payments.reduce(
    (sum, amountKobo) =>
      sum + settle(amountKobo, rates, { passToClient: draft.passFeesToClient }).userReceivesKobo,
    0,
  );

  return { receivesKobo, feesKobo: draft.totalKobo - receivesKobo };
}

export function draftSummary(draft: Draft, today: Civil, plan: "free" | "pro"): string {
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
  rows.push(...planLines(draft));
  if (draft.passFeesToClient) rows.push(row("Fees", "Client pays the transaction fee"));
  if (draft.clientEmail) rows.push(row("Email to", draft.clientEmail));

  /*
   * What they will actually be paid, under the amount they are approving.
   *
   * The invoice figure is what the client owes; it is not what arrives, and
   * the gap is a percentage somebody agreed to during onboarding and has not
   * thought about since. Saying it here, at the one moment they are looking
   * at this invoice's money, is the difference between a fee they chose and a
   * deduction they discover on the settlement.
   *
   * Only the figure is bold. The total already carries the bold in the block
   * above, and a whole line of it beside "Send it?" would leave three things
   * shouting and nothing standing out.
   *
   * Not on a sample, which is a demonstration invoice with nobody's money in
   * it — a fee line there is a number about a client who does not exist.
   */
  const ps =
    draft.type !== "sample" &&
    `PS: you receive ${b(formatNaira(payout(draft, plan).receivesKobo))} of this after fees.`;

  // Then just the question. The three answers arrive as buttons under it, so
  // spelling them out here would print the instructions twice.
  return para(
    block(`🧾 ${b(`${LABEL[draft.type].toUpperCase()} DRAFT`)}`, rows),
    ps,
    b("Send it?"),
  );
}


/**
 * The three answers to "Send it?".
 *
 * Ids are the words the parser already reads, so a tap and a typed reply take
 * exactly the same path through the machine and neither needs a special case.
 */
export const draftButtons = (): { id: string; title: string }[] => [
  { id: "yes", title: "Send it" },
  { id: "change something", title: "Change it" },
  { id: "no", title: "Discard" },
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
 * The invoice a quote became, written for the client.
 *
 * Converting used to tell the user "Quote #1 is now Invoice #2" and stop
 * there. The invoice row was written with status 'sent' and sent_at set —
 * because from the product's point of view it had been issued — but nothing
 * reached the client. No document, no link, no email. The user was left to
 * work out that "resend invoice 2" was the way to actually send it, and the
 * overdue sweep started counting down on a client who had never seen it.
 *
 * Built from the stored parts rather than from a draft, because by this point
 * the parts are the truth: `convertQuote` copies them across and resets the
 * first to payable. Re-deriving the schedule here could disagree with the
 * rows the payment page is reading.
 */
export function convertedForward(
  d: { number: number | null; clientName: string; totalKobo: number; dueDate: Civil | null },
  parts: { label: string; amountKobo: number }[],
  link: string,
  today: Civil,
): string {
  const plan = parts.length
    ? [
        "Payment plan:",
        ...parts.map(
          (p, i) => `  \u00b7 ${p.label} \u2014 ${formatNaira(p.amountKobo)}${i === 0 ? " (due now)" : ""}`,
        ),
      ]
    : [];

  return para(
    block(`\u2705 ${b("INVOICE")}`, [
      row("Client", d.clientName),
      row("Amount", b(formatNaira(d.totalKobo))),
      d.dueDate && row("Due", formatFriendly(d.dueDate, today)),
      ...plan,
    ]),
    lines("Click the link to pay:", link),
  );
}

/**
 * What goes out once a document is confirmed (F6 step 4).
 *
 * One message, written for the *client*. It carries the PDF and says "click
 * the link to pay", so the user can forward it exactly as it arrived without
 * editing anything out — and a message that has to be edited before it can be
 * sent is a message that does not get sent.
 *
 * That rule is what decides everything below: no invoice number in the
 * heading, and nothing addressed to the sender.
 */
export function sentMessage(
  draft: Draft,
  confirmed: { number: number; publicToken: string },
  baseUrl: string,
  today: Civil,
): { forward: string; note: string } {
  const label = SENT_LABEL[draft.type];
  const link = `${baseUrl.replace(/\/$/, "")}/i/${confirmed.publicToken}`;

  /*
   * A quote keeps its note; an invoice does not.
   *
   * "I will tell you the moment it is paid" is reassurance, and the bot does
   * tell them — so the line only ever reached the client, who has no idea who
   * is being told what. Nothing is lost by dropping it.
   *
   * A quote is different. It is sent expecting an answer, and converting it is
   * an action only the sender can take and would otherwise have no way to
   * learn. That instruction is worth one odd-looking line on a forward.
   */
  const note =
    draft.type === "quote"
      ? `Reply ${b(`convert quote ${confirmed.number}`)} when they accept.`
      : "";

  /*
   * No number in the heading.
   *
   * It used to read "INVOICE #3", and the whole message is built to be
   * forwarded to the client untouched — so it told them this was the third
   * invoice its sender had ever issued. A number that is only ever a count of
   * how new you are is worse than no number, and the client has no use for
   * one here: it is on the document itself, where an invoice number belongs.
   *
   * PRD-GAP: the payment page still prints "Invoice 3" in its heading and its
   * title. Hiding it here and not there is half a fix. The real answer is a
   * starting number the user chooses, which is why every invoicing tool has
   * one.
   */
  const forward = para(
    block(`✅ ${b(label.toUpperCase())}`, [
      row("Client", draft.clientName),
      row("Amount", b(formatNaira(draft.totalKobo))),
      draft.dueDate &&
        row(draft.type === "quote" ? "Valid until" : "Due", formatFriendly(draft.dueDate, today)),
      // The client is the one being asked for a deposit, so the client is the
      // one who has to be told. Without this the forward says "₦300,000, click
      // to pay" and the page it opens asks for ₦75,000, which reads as an
      // error in the sender's favour.
      ...planLines(draft),
    ]),
    lines(draft.type === "quote" ? "Click the link to view it:" : "Click the link to pay:", link),
    note,
  );

  return { forward, note };
}
