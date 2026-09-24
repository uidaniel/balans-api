/**
 * The parser, as the rest of the system sees it (PRD F3).
 *
 * Three paths, tried in order, each cheaper and more certain than the next:
 *
 *   1. A command      — "yes", "who owes me". Exact, free, instant.
 *   2. The pattern    — "Invoice Tunde 20k for logo, due Friday". Free.
 *   3. The model      — everything else.
 *
 * Whatever answers, the amounts and dates come back as written and are
 * converted by `normalise`, so no number in the result was produced by a
 * language model.
 */

import { env } from "../config.ts";
import { todayIn, type Civil } from "../../core/dates.ts";
import { readCurrency, type CurrencyRead } from "../../core/currency.ts";
import { parseAmountToKobo } from "../../core/amount.ts";
import { defaults } from "../config.ts";
import { asCommand } from "./commands.ts";
import { extractDocument, readAmount } from "./extract.ts";
import { readTemplate } from "./template.ts";
import { modelConfigured, parseWithModel } from "./model.ts";
import { normalise, isDocumentIntent, type Parsed, type RawParse } from "./schema.ts";

export type ParseOutcome =
  | { ok: true; parsed: Parsed; latencyMs: number }
  /** The model was needed and could not be reached. Section 15: say so plainly. */
  | { ok: false; reason: "too_long" | "unavailable"; latencyMs: number };

const empty = (intent: RawParse["intent"], confidence: number): RawParse => ({
  intent,
  client_name: null,
  client_email: null,
  line_items: [],
  total_amount: null,
  due_date: null,
  document_number: null,
  options: { deposit_percent: null, instalments: null, pass_fees_to_client: null, vat_percent: null, notes: null },
  correction: null,
  confidence,
});

export async function parseMessage(
  text: string,
  /**
   * `onScreen` is the draft the user is looking at, when there is one. It only
   * reaches the model, and only so that a reply to "Send it?" can be read as
   * the answer to a question rather than as a sentence out of nowhere.
   */
  opts: {
    today?: Civil;
    fetchImpl?: typeof fetch;
    onScreen?: string | null;
    /**
     * The currency of the draft on screen, when there is one.
     *
     * A correction is in the invoice's currency, not the message's: "make it
     * 600" against a dollar draft carries no mark at all and means six
     * hundred dollars. A new invoice in the same message is still read in
     * whatever currency it was written in.
     */
    correctionMoney?: CurrencyRead;
  } = {},
): Promise<ParseOutcome> {
  const started = Date.now();
  const since = () => Date.now() - started;
  const today = opts.today ?? todayIn(defaults.behaviour.timezone);

  /*
   * What currency this was written in, read once from the raw text.
   *
   * Before anything else, and stamped onto whatever comes back, because the
   * three readers below have nothing to say about currency and one of them
   * is a language model. A mark that only gets looked for on the paths that
   * expect one is a mark that goes missing on the paths that do not — and
   * the cost of it going missing is "£500" becoming an invoice for ₦500.
   */
  const money = readCurrency(text);
  const correctionMoney = opts.correctionMoney ?? money;
  const priced = (parsed: Parsed): Parsed => (parsed.money === money ? parsed : { ...parsed, money });

  // F3: inputs over 1,000 characters are rejected with a short message. The
  // check is here rather than at the model because a 40,000-character message
  // should not reach the pattern matcher either.
  if (text.length > env.PARSER_MAX_CHARS) {
    return { ok: false, reason: "too_long", latencyMs: since() };
  }

  /* 1. Commands. ----------------------------------------------------------- */
  const command = asCommand(text);
  if (command) {
    const raw = empty(command.intent, 1);
    raw.document_number = command.documentNumber ?? null;
    return { ok: true, parsed: normalise(raw, today, "command", money), latencyMs: since() };
  }

  /* 2. The form, filled in and sent back. ---------------------------------- */
  const filled = readTemplate(text, today);
  if (filled) return { ok: true, parsed: priced(filled), latencyMs: since() };

  /* 3. The sentence the product teaches. ----------------------------------- */
  const pattern = extractDocument(text, today, money);
  if (pattern && !pattern.missing.length) {
    return { ok: true, parsed: priced(pattern), latencyMs: since() };
  }

  /* 4. The model. ---------------------------------------------------------- */
  const model = await parseWithModel(text, today, opts.fetchImpl, opts.onScreen ?? null);
  if (model.ok) {
    const parsed = recoverAmount(
      normalise(model.parse, today, "model", money, correctionMoney),
      text,
      today,
    );

    // F3: "If confidence is below the configured threshold, or a required
    // field is missing, ask for that one thing only." Below the threshold the
    // answer is to ask, not to discard — and the machine already asks, because
    // `missing` is worked out here rather than guessed at by the model.
    //
    // What is not worth keeping is an uncertain document intent with nothing
    // in it: no name, no amount, nothing to ask about. That is a rambling
    // message read hopefully, and drafting from it helps nobody.
    const hasSomething = parsed.clientName !== null || parsed.totalKobo !== null;
    if (
      parsed.confidence < env.PARSER_CONFIDENCE_MIN &&
      isDocumentIntent(parsed.intent) &&
      !hasSomething
    ) {
      return { ok: true, parsed: priced({ ...parsed, intent: "unknown" }), latencyMs: since() };
    }

    return { ok: true, parsed: priced(parsed), latencyMs: since() };
  }

  // A partial pattern match is better than nothing: it knows what it is
  // missing, and asking for that one thing is exactly what F3 wants.
  if (pattern) return { ok: true, parsed: priced(pattern), latencyMs: since() };

  // Nothing read it. No key configured and the model being down are different
  // problems for us and the same problem for the user, so they get one answer
  // and the log gets the distinction.
  return { ok: false, reason: "unavailable", latencyMs: since() };
}

/** Whether document creation can work at all right now (section 15). */
export const canParseDocuments = (): boolean => modelConfigured();

/**
 * Puts back an amount the model dropped.
 *
 * Asked for ₦356,000 in "daniel uwak for his school fees 356k due tomorrow",
 * the model returned a line called "school fees" with no price and no total,
 * so the bot asked how much Daniel was paying — a question he had already
 * answered in the same sentence. Run again on the same words it got it right,
 * which is the nature of the thing: it is a model, not a parser.
 *
 * So where the model says there is no amount and the sentence plainly states
 * one, the sentence wins. The reader used here is the same deterministic one
 * behind the fast path, and it only accepts something marked as money — a
 * currency sign, a k/m/h suffix, or four digits — so it cannot turn a
 * quantity into a price.
 *
 * Deliberately one-way: it never overrides an amount the model did read, and
 * it never invents one where the text has none. And nothing it produces
 * becomes a document without the user confirming the draft (F6).
 */
function recoverAmount(parsed: Parsed, text: string, today: Civil): Parsed {
  if (!isDocumentIntent(parsed.intent)) return parsed;
  if (!parsed.missing.includes("amount")) return parsed;

  const raw = readAmount(text);
  if (!raw) return parsed;

  const kobo = parseAmountToKobo(raw);
  if (kobo === null || kobo <= 0) return parsed;

  // Onto the single line if there is one, so the work keeps its description;
  // otherwise as the total, which is what an unitemised invoice is.
  const single = parsed.lineItems.length === 1 && parsed.lineItems[0]!.unitAmountKobo === 0;
  const lineItems = single
    ? [{ ...parsed.lineItems[0]!, unitAmountKobo: kobo, qty: 1 }]
    : parsed.lineItems;

  // Rebuilt through normalise rather than patched, so `missing` and the total
  // are worked out by the one piece of code that knows how.
  return normalise(
    {
      intent: parsed.intent,
      client_name: parsed.clientName,
      client_email: parsed.clientEmail,
      line_items: lineItems.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit_amount: String(l.unitAmountKobo / 100),
      })),
      total_amount: lineItems.length ? null : String(kobo / 100),
      due_date: parsed.dueDatePhrase,
      document_number: parsed.documentNumber,
      options: {
        deposit_percent: parsed.options.depositPercent,
        instalments: parsed.options.instalments,
        pass_fees_to_client: parsed.options.passFeesToClient,
        vat_percent: parsed.options.vatPercent,
        notes: parsed.options.notes,
      },
      confidence: parsed.confidence,
      correction: null,
    },
    today,
    "model",
    parsed.money,
  );
}
