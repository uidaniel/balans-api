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
import { formatISO, resolveDueDate, type Civil } from "../../core/dates.ts";

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
  "help",
  "confirm",
  "reject",
  "unknown",
] as const;

export type Intent = (typeof INTENTS)[number];

/** The intents that produce a document, and so must pass draft-and-confirm. */
export const DOCUMENT_INTENTS: readonly Intent[] = ["create_invoice", "create_quote"];

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
      pass_fees_to_client: z.boolean().nullish().transform((v) => v ?? null),
      vat_percent: z.number().min(0).max(100).nullish().transform((v) => v ?? null),
      notes: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null }),
  confidence: z.number().min(0).max(1),
});

export type RawParse = z.infer<typeof rawParse>;

/* -------------------------------------------------------------------------- */
/* What the rest of the system uses                                           */
/* -------------------------------------------------------------------------- */

export type LineItem = { description: string; qty: number; unitAmountKobo: number };

export type Parsed = {
  intent: Intent;
  clientName: string | null;
  clientEmail: string | null;
  lineItems: LineItem[];
  /** Kobo. The sum of the line items, or the stated total when there are none. */
  totalKobo: number | null;
  dueDate: Civil | null;
  /** The phrase the date came from, so a confirmation can echo their words. */
  dueDatePhrase: string | null;
  documentNumber: number | null;
  options: {
    depositPercent: number | null;
    passFeesToClient: boolean | null;
    vatPercent: number | null;
    notes: string | null;
  };
  confidence: number;
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
export function normalise(raw: RawParse, today: Civil, source: Parsed["source"]): Parsed {
  const lineItems: LineItem[] = [];
  let unreadableAmount = false;

  for (const item of raw.line_items) {
    const kobo = item.unit_amount === null ? null : parseAmountToKobo(item.unit_amount);
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

  const stated = raw.total_amount === null ? null : parseAmountToKobo(raw.total_amount);
  if (raw.total_amount !== null && (stated === null || stated <= 0)) unreadableAmount = true;

  const summed = lineItems.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0);
  const priced = lineItems.some((l) => l.unitAmountKobo > 0);
  // Line items win over a stated total: they are the itemised truth, and a
  // mismatch between the two is the user's to resolve at the confirm step.
  // Lines with no price at all leave the total unknown, not zero.
  const totalKobo = lineItems.length ? (priced ? summed : null) : stated;

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
    clientName: raw.client_name,
    clientEmail: raw.client_email,
    lineItems,
    totalKobo,
    dueDate: resolved?.date ?? null,
    dueDatePhrase: raw.due_date,
    documentNumber: raw.document_number,
    options: {
      depositPercent: raw.options.deposit_percent,
      passFeesToClient: raw.options.pass_fees_to_client,
      vatPercent: raw.options.vat_percent,
      notes: raw.options.notes,
    },
    confidence: raw.confidence,
    source,
    missing,
  };
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
