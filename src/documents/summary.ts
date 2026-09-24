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

import { formatFriendly, type Civil, compare } from "../../core/dates.ts";
import { DEFAULT_INTL_PROCESSOR, settle, withVat } from "../../core/fees.ts";
import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { formatMoney, INFO } from "../../core/currency.ts";
import { impliedRate } from "../../core/exchange.ts";
import { b, block, lines, para, row } from "../whatsapp/format.ts";
import { shapeFor, stagesFor, type Stage, dueDateWithStages } from "./parts.ts";
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
export function planLines(
  draft: {
    totalKobo: number;
    depositPercent: number | null;
    instalments: number | null;
    dueDate: Civil | null;
    stageDueDates?: (Civil | null)[] | null;
  },
  today: Civil,
): string[] {
  const stages = stagesFor(draft, draft.totalKobo, today);
  if (!stages) return [];

  /*
   * "Due now" only while it really is now.
   *
   * The first part's date is normally today, so printing it would say what
   * the tag already says and in more words \u2014 but it is not always today any
   * more. "Let the 50% deposit be due on Friday" sets it, and this said "due
   * now" regardless, which made the draft look like the change had been
   * ignored even though it had been applied.
   */
  const when = (s: Stage, i: number): string => {
    if (!s.dueOn) return i === 0 ? " (due now)" : "";
    const isToday = compare(s.dueOn, today) === 0;
    return isToday && i === 0 ? " (due now)" : ` (due ${formatFriendly(s.dueOn, today)})`;
  };

  return [
    "Payment plan:",
    ...stages.map((s, i) => `  · ${s.label} — ${formatNaira(s.amountKobo)}${when(s, i)}`),
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
/** Every figure a receipt needs, in the order somebody reads them. */
export type Payout = {
  /** What the client is charged. Above the invoice when fees are passed on. */
  clientPaysKobo: number;
  processorFeeKobo: number;
  balansFeeKobo: number;
  /** What lands in the bank. */
  receivesKobo: number;
  /** The invoice minus what lands, which is not the sum of the two fees when
   * the client is paying the processor's. */
  feesKobo: number;
};

export function payout(
  draft: {
    totalKobo: number;
    depositPercent: number | null;
    instalments: number | null;
    passFeesToClient: boolean;
    /** Set on an invoice priced abroad, which is charged by card, not transfer. */
    foreign?: { currency: string } | null;
  },
  plan: "free" | "pro",
): Payout {
  const p = defaults.plans[plan];
  const rates = { percentBps: p.feePercentBps, minKobo: p.feeMinKobo, capKobo: p.feeCapKobo };

  /*
   * Which processor, and it is not a detail.
   *
   * A naira invoice is a bank transfer through Monnify at 1.5% capped at
   * ₦2,000. An invoice priced abroad is an international card through
   * Paystack at 3.9% with no cap at all. On a ₦663,500 invoice that is ₦2,000
   * against ₦25,976 — and the number this produces is the one the freelancer
   * reads under "you receive" before agreeing to send it.
   */
  const processor = draft.foreign
    ? withVat(DEFAULT_INTL_PROCESSOR, defaults.international.feeVatPercent)
    : undefined;

  const shape = shapeFor(draft, draft.totalKobo);
  const payments = shape?.length ? shape.map((s) => s.amountKobo) : [draft.totalKobo];

  /*
   * Summed per payment, and the two fees kept apart.
   *
   * They are not ours to blur: Monnify's cut comes out whoever we are, and
   * the Balans fee is the one the user is choosing between plans about. A
   * receipt that showed one number called "fees" would be hiding the only
   * line Pro changes.
   */
  let clientPaysKobo = 0;
  let processorFeeKobo = 0;
  let balansFeeKobo = 0;
  let receivesKobo = 0;

  /*
   * Our fee is capped across the invoice, Monnify's is charged per payment.
   *
   * So the running total goes in, and each payment is only charged the
   * difference it makes to the fee on everything before it. Without it a
   * ₦200,000 invoice split 20/80 showed ₦1,400 of Balans fee against a cap of
   * ₦1,000 — and worse, charged it.
   */
  let paidBeforeKobo = 0;

  for (const amountKobo of payments) {
    const part = settle(amountKobo, rates, {
      passToClient: draft.passFeesToClient,
      paidBeforeKobo,
      processor,
    });
    paidBeforeKobo += amountKobo;
    clientPaysKobo += part.clientPaysKobo;
    processorFeeKobo += part.processorFeeKobo;
    balansFeeKobo += part.balansFeeKobo;
    receivesKobo += part.userReceivesKobo;
  }

  return {
    clientPaysKobo,
    processorFeeKobo,
    balansFeeKobo,
    receivesKobo,
    feesKobo: draft.totalKobo - receivesKobo,
  };
}

export function draftSummary(
  draft: Draft,
  today: Civil,
  plan: "free" | "pro",
  /**
   * False when a receipt card is going above this message.
   *
   * The card itemises the fees, so the PS would be the same arithmetic twice
   * — once drawn and once written. Everything else stays in words, because a
   * picture cannot be searched in a chat or read aloud.
   */
  fees = true,
): string {
  /*
   * One group per thing somebody checks, with a blank line between them.
   *
   * A section rather than a row, because `block` joins everything with single
   * newlines and drops empty strings on the way — there is no way to ask it
   * for a gap. Fourteen lines of label-and-value with nothing between them is
   * a wall, and the reader is scanning for one number in it.
   */
  const sections: (string | false)[][] = [[row("Client", draft.clientName)]];

  // One line reads as a single "Item" row. Several deserve their own lines,
  // because the itemisation is the part a client queries.
  //
  // "Item" rather than "Work" because that is what the form calls this field
  // now, and a draft that answers a question in a different word than the one
  // it was asked in reads like a different field.
  if (draft.lines.length === 1) {
    const only = draft.lines[0]!;
    sections.push([row("Item", `${only.description}${only.qty === 1 ? "" : ` x${only.qty}`}`)]);
  } else {
    // The items stay together as one group: they are a list, and a blank line
    // between two things being billed for would read as two invoices.
    sections.push([
      "Items:",
      ...draft.lines.map((line) => {
        const each = line.qty === 1 ? "" : ` x${line.qty}`;
        // Priced in the currency it was agreed in. A dollar invoice that
        // itemises in naira is asking the freelancer to check arithmetic they
        // never did.
        const money =
          draft.foreign && line.originalUnitAmountMinor !== undefined
            ? formatMoney(line.originalUnitAmountMinor * line.qty, draft.foreign.currency)
            : formatNaira(line.unitAmountKobo * line.qty);
        return `  · ${line.description}${each} — ${money}`;
      }),
    ]);
  }

  // Subtotal only when VAT makes it differ from the total: showing the same
  // number twice is noise on the one line somebody is checking.
  // One group, because it is one sum: the subtotal and the VAT are the
  // arithmetic that produces the amount, and reading them apart makes three
  // facts out of a single addition somebody is checking in one glance.
  sections.push([
    ...(draft.vatKobo > 0
      ? [
          row("Subtotal", formatNaira(draft.subtotalKobo)),
          row(`VAT ${draft.vatPercent}%`, formatNaira(draft.vatKobo)),
        ]
      : []),
    row(
      "Amount",
      b(
        draft.foreign
          ? formatMoney(draft.foreign.amountMinor, draft.foreign.currency)
          : formatNaira(draft.totalKobo),
      ),
    ),
  ]);

  /*
   * What the client is actually charged, and at what rate (section 9).
   *
   * Nobody is ever charged in dollars. The card is debited in naira, the
   * client's own bank converts, and this is the figure that leaves their
   * account — so it belongs directly under the price, before the due date,
   * not in a footnote. The rate is derived from the two numbers rather than
   * printed from the quote, so the sentence and the figure beside it cannot
   * disagree after rounding.
   */
  if (draft.foreign) {
    const rate = impliedRate(draft.totalKobo, draft.foreign.amountMinor);
    sections.push([
      row("Charged in naira", b(formatNaira(draft.totalKobo))),
      row("Today's rate", `${formatNaira(Math.round(rate * 100))}/${INFO[draft.foreign.currency].symbol}`),
    ]);
  }

  /*
   * The date the last money is expected, which is not always the date on the
   * draft.
   *
   * A part moved past the end pushes the end out with it (see `scheduleFor`).
   * Reading `draft.dueDate` straight would put one date in this row and a
   * later one on the last line of the plan, three rows below it, on the same
   * card.
   */
  const due = dueDateWithStages(draft, draft.totalKobo, today) ?? draft.dueDate;
  if (due) {
    sections.push([row(draft.type === "quote" ? "Valid until" : "Due", formatFriendly(due, today))]);
  }

  // The plan is a list like the items, and stays in one piece for the same
  // reason: its parts are halves of one arrangement.
  const planRows = planLines(draft, today);
  if (planRows.length) sections.push(planRows);

  if (draft.passFeesToClient) sections.push([row("Fees", "Client pays the transaction fee")]);
  if (draft.clientEmail) sections.push([row("Email to", draft.clientEmail)]);

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
    fees &&
    draft.type !== "sample" &&
    `PS: you receive ${b(formatNaira(payout(draft, plan).receivesKobo))} of this after fees.`;

  /*
  /*
   * When the money arrives is said on the card, and only on the card.
   *
   * It used to be here as well, so the picture and the words under it both
   * answered the same question — the one question somebody actually has
   * before pressing send. Saying it twice made neither of them the answer,
   * and the card's version is the one that can be read at a glance and
   * forwarded as an image.
   */

  // Then just the question. The three answers arrive as buttons under it, so
  // spelling them out here would print the instructions twice.
  return para(
    `🧾 ${b(`${LABEL[draft.type].toUpperCase()} DRAFT`)}`,
    ...sections.map((s) => lines(...s)).filter(Boolean),
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
 * The three things somebody does with a quote once it is out.
 *
 * Same trick as `draftButtons`: every id is a sentence `commands.ts` already
 * matches, so a tap and a typed reply take one path and there is no button
 * handler to keep in step with the parser. `convert quote 1`, `resend quote
 * 1` and `cancel quote 1` are all existing commands.
 *
 * This replaces "Reply *convert quote 1* when they accept" — an instruction
 * that had to be read, remembered for days, and then typed correctly from
 * memory at the one moment the money was on the table. Worse, it rode in the
 * caption of a document built to be forwarded, so the client was told how to
 * convert somebody else's quote.
 *
 * Titles are capped at 20 characters by Meta, so they are short by force
 * rather than by choice.
 */
export const quoteButtons = (number: number): { id: string; title: string }[] => [
  { id: `convert quote ${number}`, title: "Convert to invoice" },
  { id: `resend quote ${number}`, title: "Send link again" },
  { id: `cancel quote ${number}`, title: "Discard" },
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
  /*
   * Nothing to remember and nothing to type.
   *
   * This used to read "Reply *convert quote 1* when they accept" — an
   * instruction the sender had to hold on to for days and then type correctly
   * at the one moment money was on the table. And because the whole message is
   * built to be forwarded untouched, it went to the client too, telling them
   * how to convert a quote that was not theirs.
   *
   * `quoteButtons` carries the three actions instead, on a message of its own
   * after the document. A document cannot hold buttons, so it costs a second
   * send — free, because it is inside the service window the sender opened.
   */
  const note = "";

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
      /*
       * The price the two of them agreed, not the naira it converts to.
       *
       * This message is built to be forwarded to the client untouched, and it
       * was quoting a figure they had never seen: a £500 quote arrived reading
       * "Amount: ₦963,066.70", with no mention of pounds anywhere on it. The
       * draft card one message earlier had it right, which is how the
       * disagreement was spotted.
       *
       * The fifth thing to get this wrong by reading `totalKobo` and assuming
       * naira, after the PDF, the receipt card, the public page and
       * `convertQuote`. Always `draft.foreign` first.
       */
      row(
        "Amount",
        b(
          draft.foreign
            ? formatMoney(draft.foreign.amountMinor, draft.foreign.currency)
            : formatNaira(draft.totalKobo),
        ),
      ),
      draft.dueDate &&
        row(draft.type === "quote" ? "Valid until" : "Due", formatFriendly(draft.dueDate, today)),
      // The client is the one being asked for a deposit, so the client is the
      // one who has to be told. Without this the forward says "₦300,000, click
      // to pay" and the page it opens asks for ₦75,000, which reads as an
      // error in the sender's favour.
      ...planLines(draft, today),
    ]),
    lines(draft.type === "quote" ? "Click the link to view it:" : "Click the link to pay:", link),
    note,
  );

  return { forward, note };
}
