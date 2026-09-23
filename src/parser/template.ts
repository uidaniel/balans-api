/**
 * A form, filled in and sent back in one message.
 *
 * Asking one question at a time is kinder to read and costs a message per
 * question. From October 2026 that is around ₦14 each, so a four-question
 * invoice costs ₦56 before anybody has been billed anything — on a plan whose
 * minimum fee is ₦100.
 *
 * So the guided path sends a form instead: one message out, one message back,
 * and the whole document arrives at once. It also removes the guessing. "How
 * much?" invites "500$"; "Amount:" next to an example does not.
 *
 * Read here rather than by the model, because a form is a fixed shape and a
 * model call would cost money to parse something a regex already understands.
 */

import type { Civil } from "../../core/dates.ts";
import { normalise, type Intent, type Parsed, type RawParse } from "./schema.ts";

/**
 * The labels, and everything people will write instead of them.
 *
 * Generous on purpose: somebody retyping the form from memory, or their
 * phone's autocorrect, should not land on "I did not understand that".
 */
const FIELDS: { key: "client" | "email" | "amount" | "description" | "due"; labels: string[] }[] = [
  { key: "client", labels: ["client", "client name", "customer", "name", "bill to", "billed to", "to", "who"] },
  {
    key: "email",
    labels: ["client email", "email", "customer email", "their email", "email address"],
  },
  { key: "amount", labels: ["amount", "total", "price", "cost", "how much", "fee", "sum"] },
  { key: "description", labels: ["for", "description", "work", "service", "services", "item", "details", "what"] },
  { key: "due", labels: ["due", "due date", "when", "deadline", "pay by", "payable"] },
];

/** Every label, longest first, so "client name" wins over "client". */
const LABELS: [string, (typeof FIELDS)[number]["key"]][] = FIELDS.flatMap((f) =>
  f.labels.map((l) => [l, f.key] as [string, (typeof FIELDS)[number]["key"]]),
).sort((a, b) => b[0].length - a[0].length);

export type Filled = Partial<Record<"client" | "email" | "amount" | "description" | "due", string>>;

/**
 * Pulls labelled values out of a message.
 *
 * Returns what it found, however little. The caller decides whether that is
 * enough to be a form rather than a sentence that happens to contain a colon.
 */
export function readFields(text: string): Filled {
  const out: Filled = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // "Client: Tunde", "Client - Tunde", "Client — Tunde".
    const split = /^([^:\-–—]{1,24})\s*[:\-–—]\s*(.*)$/.exec(line);
    if (!split) continue;

    const label = split[1]!.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    const value = split[2]!.trim();
    if (!value) continue; // An unfilled line is not an answer.

    const match = LABELS.find(([l]) => l === label);
    if (!match) continue;

    // First one wins: a form filled in twice is the first attempt, and the
    // second is usually the blank template pasted underneath.
    out[match[1]] ??= value;
  }

  return out;
}

/**
 * Reads a filled-in form as a document.
 *
 * Requires at least two labelled fields. One line with a colon in it is a
 * sentence — "Note: pay by Friday" — and treating that as a form would hijack
 * ordinary messages.
 */
export function readTemplate(
  text: string,
  today: Civil,
  type: Intent = "create_invoice",
): Parsed | null {
  const fields = readFields(text);
  const found = Object.keys(fields).length;
  if (found < 2) return null;

  // A form with no client and no amount is not a document, whatever else it
  // carries: those are the two things F6 requires.
  if (!fields.client && !fields.amount) return null;

  const raw: RawParse = {
    intent: type,
    correction: null,
    client_name: fields.client ?? null,
    // Optional, and the only field that buys something new: with it, F21
    // emails the invoice and the PDF straight to the client.
    client_email: fields.email ?? null,
    line_items:
      fields.description && fields.amount
        ? [{ description: fields.description, qty: 1, unit_amount: fields.amount }]
        : fields.description
          ? [{ description: fields.description, qty: 1, unit_amount: null }]
          : [],
    total_amount: fields.description ? null : (fields.amount ?? null),
    due_date: fields.due ?? null,
    document_number: null,
    options: { deposit_percent: null, instalments: null, pass_fees_to_client: null, vat_percent: null, notes: null },
    // A form is explicit. There is nothing to be unsure about except whether
    // the values parse, which `normalise` decides.
    confidence: 1,
  };

  // `normalise` converts the amount and the date, and records either as
  // missing when it cannot — which is exactly what the form should do with a
  // line somebody filled in wrongly.
  return normalise(raw, today, "pattern");
}

/** True when a message is clearly somebody filling in the form. */
export const looksLikeTemplate = (text: string): boolean =>
  Object.keys(readFields(text)).length >= 2;
