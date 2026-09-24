/**
 * What the parser returns (PRD F3).
 *
 * The model reads words and returns *strings*. It never returns a number of
 * kobo and never returns a calendar date. "350k" comes back as "350k" and
 * "due Friday" comes back as "Friday", and `parseAmountToKobo` and
 * `resolveDueDate` turn those into values.
 *
 * That is PRD rule 2 — the language model never does money maths — taken
 * literally. A model that returns 350000 has done arithmetic nobody can test,
 * and the day it returns 35000 instead there is nothing to catch it. A model
 * that returns "350k" has done the one job it is good at.
 */

import { z } from "zod";
import { parseAmountToKobo } from "../../core/amount.ts";
import { parseAmountToMinor, type CurrencyRead } from "../../core/currency.ts";
import { formatISO, resolveDueDate, type Civil } from "../../core/dates.ts";
import { titleCaseName } from "../../core/names.ts";
// Type only: `corrections.ts` reaches back into this file's neighbours, and a
// value import here would close the ring.
import type { Correction } from "./corrections.ts";

export const INTENTS = [
  "create_invoice",
  "create_quote",
  "convert_quote",
  "payment_request",
  "status",
  "debtors",
  "summary",
  "edit_document",
  "cancel_document",
  "resend_document",
  "record_payment",
  "settings",
  "upgrade",
  "referral",
  /** F13: "stop reminders for invoice 14". */
  "stop_reminders",
  /** Choosing an invoice design. Advertised on the site, not built. */
  "templates",
  "remove_logo",
  "help",
  "confirm",
  "reject",
  /**
   * A change to the draft that is on screen right now.
   *
   * Only offered to the model when there is one, and only reached when the
   * deterministic reader in `corrections.ts` could not do it for free. That
   * reader knows five shapes and people write in more than five: "correct the
   * work, it is photography" was answered with "I did not catch that", which
   * is the bot asking somebody to guess the phrasing it wants.
   */
  "correct_draft",
  /**
   * Somebody being a person: "thank you", "good morning", "this is nice".
   *
   * Its own intent rather than "unknown", because the two need opposite
   * answers. Unknown means the message asked for something this tool cannot
   * do, and the right reply is to say what it does. "Thank you" asked for
   * nothing — answering it with "I only do quotes, invoices and payments"
   * reads as a machine that was not listening.
   */
  "social",
  "unknown",
] as const;

export type Intent = (typeof INTENTS)[number];

/** The intents that produce a document, and so must pass draft-and-confirm. */
export const DOCUMENT_INTENTS: readonly Intent[] = [
  "create_invoice",
  "create_quote",
  // F8: a payment request goes through the same draft-and-confirm as anything
  // else that asks somebody for money.
  "payment_request",
];

export const isDocumentIntent = (i: Intent): boolean => DOCUMENT_INTENTS.includes(i);

/* -------------------------------------------------------------------------- */
/* What the model is allowed to say                                           */
/* -------------------------------------------------------------------------- */

const nullableStr = z.string().trim().min(1).max(200).nullish().transform((v) => v ?? null);

export const rawLineItem = z.object({
  description: z.string().trim().min(1).max(200),
  qty: z.number().positive().max(10_000).nullish().transform((v) => v ?? 1),
  /**
   * As written: "350k", "1.2m", "N5,000". Converted here, never by the model.
   *
   * Null when the work was named but not priced. "Invoice Kemi for the
   * photoshoot" knows what it is for and not what it costs, and throwing the
   * description away would mean asking for something already said.
   */
  unit_amount: z.string().trim().min(1).max(40).nullish().transform((v) => v ?? null),
});

/**
 * A change to the draft on screen, in the model's words.
 *
 * Same discipline as everything else here: the amount comes back as it was
 * written and the date comes back as a phrase, and both are converted below.
 * A model that returns 40000000 has done arithmetic nobody can test.
 *
 * Every field is "leave this alone" when it is null, which is why removing
 * something needs its own list — "no VAT" and "say nothing about VAT" are
 * different instructions and JSON has one null for both.
 */
export const rawCorrection = z.object({
  amount: z.string().trim().min(1).max(40).nullish().transform((v) => v ?? null),
  due_date: z.string().trim().min(1).max(60).nullish().transform((v) => v ?? null),
  client_name: z.string().trim().min(1).max(200).nullish().transform((v) => v ?? null),
  /** Where the client's copy goes. Put "email" in `clear` to take it off. */
  client_email: z.string().trim().email().max(254).nullish().transform((v) => v ?? null),
  description: z.string().trim().min(1).max(200).nullish().transform((v) => v ?? null),
  vat_percent: z.number().min(0).max(100).nullish().transform((v) => v ?? null),
  deposit_percent: z.number().min(1).max(100).nullish().transform((v) => v ?? null),
  instalments: z.number().int().min(2).max(12).nullish().transform((v) => v ?? null),
  pass_fees_to_client: z.boolean().nullish().transform((v) => v ?? null),
  /**
    * Whole lines to put on the end of the draft.
    *
    * The same shape as the line items in a new invoice, because it is the
    * same thing: "add SEO 100k" against a draft and "logo 50k, SEO 100k" in
    * a first message are one ability pointed at two moments.
    */
  add_lines: z.array(rawLineItem).max(10).nullish().transform((v) => v ?? []),
  /** Words naming a line to take off, or its number: "the SEO line", "2". */
  remove_line: z.string().trim().min(1).max(120).nullish().transform((v) => v ?? null),
  /**
   * Rewording a line that is already there, keeping its price.
   *
   * Its own field because the obvious alternative — remove it and add it
   * back — deletes the line and its money whenever the replacement arrives
   * without a price, which is most of the time when somebody is only fixing
   * the wording.
   */
  rename_line: z
    .object({
      match: z.string().trim().min(1).max(200),
      to: z.string().trim().min(1).max(200),
    })
    .nullish()
    .transform((v) => v ?? null),
  /**
   * A new price for one line, named, leaving the others alone.
   *
   * Distinct from `amount`, which is the document's total and replaces every
   * line with one. On a draft with several lines that difference is two
   * lines of somebody's work: "change the ui amount to 400k" read as a total
   * turned a ₦1,250,000 invoice for three items into one item at ₦400,000.
   *
   * The amount comes back as written, like every other amount here, and is
   * converted by our own code.
   */
  set_line_amount: z
    .object({
      match: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(40),
    })
    .nullish()
    .transform((v) => v ?? null),
  /**
   * A date for one part of the payment plan, rather than for the document.
   *
   * "deposit" and "balance" rather than a number, because which number they
   * are depends on the plan: the balance is part two of a deposit and part
   * five of five instalments, and only the machine holding the draft knows
   * which. The date is a phrase, like every other date the model returns.
   */
  stage_due: z
    .object({
      stage: z.union([z.enum(["deposit", "balance"]), z.number().int().min(1).max(12)]),
      due_date: z.string().trim().min(1).max(60),
    })
    .nullish()
    .transform((v) => v ?? null),
  clear: z
    .array(z.enum(["vat", "deposit", "instalments", "email"]))
    .max(4)
    .nullish()
    .transform((v) => v ?? []),
});

export type RawCorrection = z.infer<typeof rawCorrection>;

export const rawParse = z.object({
  intent: z.enum(INTENTS),
  client_name: nullableStr,
  client_email: z.string().trim().email().max(254).nullish().transform((v) => v ?? null),
  line_items: z.array(rawLineItem).max(20).nullish().transform((v) => v ?? []),
  /** As written. Only used when there are no line items to add up. */
  total_amount: z.string().trim().min(1).max(40).nullish().transform((v) => v ?? null),
  /** The phrase, not a date: "Friday", "month end", "in two weeks". */
  due_date: z.string().trim().min(1).max(60).nullish().transform((v) => v ?? null),
  /** A number already in the message, for "cancel invoice 12". */
  document_number: z.number().int().positive().max(1_000_000).nullish().transform((v) => v ?? null),
  options: z
    .object({
      deposit_percent: z.number().min(1).max(100).nullish().transform((v) => v ?? null),
      /** "three payments", "in 4 instalments". The count, never the amounts. */
      instalments: z.number().int().min(2).max(12).nullish().transform((v) => v ?? null),
      pass_fees_to_client: z.boolean().nullish().transform((v) => v ?? null),
      vat_percent: z.number().min(0).max(100).nullish().transform((v) => v ?? null),
      notes: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? { deposit_percent: null, instalments: null, pass_fees_to_client: null, vat_percent: null, notes: null }),
  /** Only ever set alongside `correct_draft`, and only when a draft exists. */
  correction: rawCorrection.nullish().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1),
});

export type RawParse = z.infer<typeof rawParse>;

/* -------------------------------------------------------------------------- */
/* What the rest of the system uses                                           */
/* -------------------------------------------------------------------------- */

/**
 * A line of work, and what it costs.
 *
 * `unitAmountKobo` is kobo on a naira parse and *minor units of the invoice's
 * currency* on a foreign one — cents on a dollar invoice, pence on a pound
 * one. The name is kept because every other reader of a parse is a naira
 * reader, and `money` on the parse is what says which it is.
 *
 * That is one hop, and it ends at the machine: `startDocument` converts at
 * the locked rate and everything downstream of it is naira kobo again, as it
 * has always been. Nothing but the machine should look at these two fields
 * without also looking at `money`.
 */
export type LineItem = { description: string; qty: number; unitAmountKobo: number };

export type Parsed = {
  intent: Intent;
  clientName: string | null;
  clientEmail: string | null;
  lineItems: LineItem[];
  /**
   * The sum of the line items, or the stated total when there are none.
   *
   * In the currency `money` names: kobo on a naira parse, cents or pence on
   * a foreign one. See `LineItem`.
   */
  totalKobo: number | null;
  dueDate: Civil | null;
  /** The phrase the date came from, so a confirmation can echo their words. */
  dueDatePhrase: string | null;
  documentNumber: number | null;
  options: {
    depositPercent: number | null;
    instalments: number | null;
    passFeesToClient: boolean | null;
    vatPercent: number | null;
    notes: string | null;
  };
  confidence: number;
  /**
   * What currency the message was written in (International PRD section 5).
   *
   * Read from the raw text by `core/currency.ts`, never by the model, and
   * carried on every parse rather than only on the ones that look foreign.
   * The reason is the failure it prevents: a reader that only looks when it
   * expects to look is a reader that turns "£500" into an invoice for
   * ₦500 whenever something upstream forgets to ask.
   *
   * Defaults to naira, which every Balans message has been until now, so
   * nothing that does not care about currency has to know this is here.
   */
  money: CurrencyRead;
  /**
   * A change to the draft on screen, when the message was one.
   *
   * The machine treats this exactly as it treats the free reader's output, so
   * a correction the model read and a correction a regex read are the same
   * thing by the time anything acts on them.
   */
  correction: Correction | null;
  /** Where it came from, for the parser log and for deciding what to trust. */
  source: "command" | "pattern" | "model";
  /**
   * The one thing to ask for, if anything. F3: ask for that one thing only.
   * Ordered by what blocks the draft first.
   */
  missing: Missing[];
};

export type Missing = "client_name" | "amount" | "description" | "due_date";

/**
 * Turns what the model said into values.
 *
 * Anything that will not convert is dropped and recorded as missing, rather
 * than guessed at. An amount we cannot read is the one thing that must never
 * be invented.
 */
export function normalise(
  raw: RawParse,
  today: Civil,
  source: Parsed["source"],
  money: CurrencyRead = { kind: "naira" },
  /**
   * The currency of the draft on screen, when a draft is on screen.
   *
   * Separate from `money` because a message can be both things at once. On
   * "Send it?" for a dollar invoice, "make it 600" is a correction in dollars
   * while "now invoice Kemi 50k" is a new invoice in naira — and the currency
   * of the one says nothing about the currency of the other.
   */
  correctionMoney: CurrencyRead = money,
): Parsed {
  const lineItems: LineItem[] = [];
  let unreadableAmount = false;

  /*
   * Amounts are read in the currency the message is in, decided once by
   * `readCurrency` over the whole message rather than per amount.
   *
   * Which is the only way a second line written as a bare "300" on a dollar
   * invoice comes out as three hundred dollars. Reading each amount on its
   * own would make that one three hundred naira, and the invoice would add
   * two currencies together into a figure that means nothing at all.
   */
  const toMinor = (s: string): number | null =>
    money.kind === "foreign" ? parseAmountToMinor(s, money.currency) : parseAmountToKobo(s);

  for (const item of raw.line_items) {
    const kobo = item.unit_amount === null ? null : toMinor(item.unit_amount);
    if (kobo === null || kobo <= 0) {
      // Kept at zero rather than dropped: zero is not an invented amount, the
      // description is real, and `missing` below makes sure nothing is drafted
      // until a price arrives to fill it in.
      unreadableAmount = true;
      lineItems.push({ description: item.description, qty: item.qty, unitAmountKobo: 0 });
      continue;
    }
    lineItems.push({ description: item.description, qty: item.qty, unitAmountKobo: kobo });
  }

  const stated = raw.total_amount === null ? null : toMinor(raw.total_amount);
  if (raw.total_amount !== null && (stated === null || stated <= 0)) unreadableAmount = true;

  const summed = lineItems.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0);
  const priced = lineItems.some((l) => l.unitAmountKobo > 0);
  // Line items win over a stated total: they are the itemised truth, and a
  // mismatch between the two is the user's to resolve at the confirm step.
  //
  // Unpriced lines are the exception. The model quite often splits "school
  // fees 356k" into a line called "school fees" and forgets to put the money
  // on it — and when it does that it usually still reports the total. Dropping
  // the total there loses an amount the user plainly wrote, and asks them for
  // something they have already said.
  const totalKobo = lineItems.length ? (priced ? summed : stated) : stated;

  const resolved = raw.due_date ? resolveDueDate(raw.due_date, today) : null;

  const missing: Missing[] = [];
  if (isDocumentIntent(raw.intent)) {
    if (!raw.client_name) missing.push("client_name");
    if (totalKobo === null || totalKobo <= 0 || unreadableAmount) missing.push("amount");
    if (!lineItems.length && !raw.options.notes) missing.push("description");
    // A missing due date is not missing: F14 gives it a default. Only a phrase
    // we could not read is worth asking about, because they did say something.
    if (raw.due_date && !resolved) missing.push("due_date");
  }

  return {
    intent: raw.intent,
    // A phone keyboard does not capitalise mid-sentence, and the result ends
    // up on an invoice somebody's client reads.
    clientName: raw.client_name ? titleCaseName(raw.client_name) : null,
    clientEmail: raw.client_email,
    lineItems,
    totalKobo,
    dueDate: resolved?.date ?? null,
    dueDatePhrase: raw.due_date,
    documentNumber: raw.document_number,
    options: {
      depositPercent: raw.options.deposit_percent,
      instalments: raw.options.instalments,
      passFeesToClient: raw.options.pass_fees_to_client,
      vatPercent: raw.options.vat_percent,
      notes: raw.options.notes,
    },
    confidence: raw.confidence,
    money,
    /*
     * Only with the intent that means it, so a correction cannot arrive
     * attached to something else and quietly win. "now invoice Kemi 50k" is a
     * new document even if the model also filled this in, and "no" is still a
     * rejection.
     */
    correction:
      raw.intent === "correct_draft" ? asCorrection(raw.correction, today, correctionMoney) : null,
    source,
    missing,
  };
}

/**
 * The model's correction, turned into values.
 *
 * Nothing that will not convert survives: an amount that cannot be read is
 * dropped rather than guessed at, and so is a date phrase that resolves to
 * nothing. A correction with nothing left in it is null, which sends the
 * message down the "I did not catch that" road — the right end for a change
 * nobody could read, and the wrong end only if we had invented something.
 */
function asCorrection(
  raw: RawCorrection | null,
  today: Civil,
  money: CurrencyRead,
): Correction | null {
  if (!raw) return null;

  const out: Correction = {};

  // In the currency of the invoice being corrected, which is what `money` is
  // here — not the currency of the words, which for "make it 600" is nothing.
  const toMinor = (v: string): number | null =>
    money.kind === "foreign" ? parseAmountToMinor(v, money.currency) : parseAmountToKobo(v);

  const kobo = raw.amount === null ? null : toMinor(raw.amount);
  if (kobo !== null && kobo > 0) out.totalKobo = kobo;

  const due = raw.due_date === null ? null : resolveDueDate(raw.due_date, today);
  if (due) {
    out.dueDate = due.date;
    out.duePhrase = raw.due_date!;
  }

  /*
   * Lines added, and one taken away.
   *
   * A line with no price is dropped rather than added at zero: "add the
   * photoshoot" names work without saying what it costs, and a ₦0 line on
   * somebody's invoice is worse than no line at all.
   */
  /*
   * Lines added, and one taken away.
   *
   * A line with no price cannot be added: "add the photoshoot" names work
   * without saying what it costs, and a ₦0 line on somebody's invoice is
   * worse than no line at all.
   *
   * But dropping it on its own is what turned a misreading into deleted
   * money. "change the commercial for opay to commercial for Opay Nigeria"
   * came back from the model as a removal plus an addition — a reasonable
   * way to say "rename" with no rename field to use. The addition had no
   * price and was dropped; the removal was not, so a ₦2,500,000 line
   * vanished and the invoice fell to ₦215,000, with nothing saying why.
   *
   * So a dropped line drops the whole correction. The message goes back as
   * "I did not catch that", which costs somebody one more sentence — against
   * an invoice that is quietly missing its largest item.
   */
  const priced = raw.add_lines.map((l) => ({
    description: l.description,
    unitAmountKobo: l.unit_amount === null ? null : toMinor(l.unit_amount),
  }));
  const added = priced.filter(
    (l): l is { description: string; unitAmountKobo: number } => (l.unitAmountKobo ?? 0) > 0,
  );
  if (added.length !== priced.length) return null;
  if (added.length) out.addLines = added;

  if (raw.stage_due) {
    const when = resolveDueDate(raw.stage_due.due_date, today);
    if (when) {
      out.stageDue = {
        which:
          raw.stage_due.stage === "deposit"
            ? "first"
            : raw.stage_due.stage === "balance"
              ? "last"
              : raw.stage_due.stage,
        date: when.date,
        phrase: raw.stage_due.due_date,
      };
    }
  }

  if (raw.rename_line) out.renameLine = raw.rename_line;

  if (raw.set_line_amount) {
    const kobo = toMinor(raw.set_line_amount.amount);
    // A line the model could not price is not a correction. Dropping the
    // amount and keeping the name would rewrite a line to nothing.
    if (kobo !== null && kobo > 0) {
      out.setLineAmount = { match: raw.set_line_amount.match, amountKobo: kobo };
    }
  }

  if (raw.remove_line) {
    const position = /^(?:item|line|number|no\.?)?\s*(\d{1,2})(?:st|nd|rd|th)?$/i.exec(raw.remove_line);
    out.removeLine = position
      ? { position: Number(position[1]) }
      : { match: raw.remove_line };
  }

  if (raw.client_name) out.clientName = titleCaseName(raw.client_name);
  if (raw.client_email) out.clientEmail = raw.client_email.toLowerCase();
  if (raw.description) out.description = raw.description;
  if (raw.vat_percent !== null) out.vatPercent = raw.vat_percent;
  if (raw.pass_fees_to_client !== null) out.passFeesToClient = raw.pass_fees_to_client;

  /*
   * A deposit and instalments are two answers to one question, so asking for
   * either clears the other. The same rule as the free reader, for the same
   * reason: `shapeFor` prefers the deposit, so a leftover one would quietly
   * beat the split somebody just asked for.
   */
  if (raw.deposit_percent !== null) {
    out.depositPercent = raw.deposit_percent;
    out.instalments = null;
  } else if (raw.instalments !== null) {
    out.instalments = raw.instalments;
    out.depositPercent = null;
  }

  // Removals last: "50% deposit, and no VAT" is one message.
  for (const field of raw.clear) {
    if (field === "vat") out.vatPercent = null;
    if (field === "deposit") out.depositPercent = null;
    if (field === "instalments") out.instalments = null;
    if (field === "email") out.clientEmail = null;
  }

  return Object.keys(out).length ? out : null;
}

/** Compact form for the parser log (PRD section 7, `parser_logs`). */
export function forLog(p: Parsed): Record<string, unknown> {
  return {
    intent: p.intent,
    source: p.source,
    confidence: p.confidence,
    client: p.clientName,
    items: p.lineItems.length,
    totalKobo: p.totalKobo,
    due: p.dueDate ? formatISO(p.dueDate) : null,
    missing: p.missing,
  };
}
