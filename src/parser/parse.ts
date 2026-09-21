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
import { defaults } from "../config.ts";
import { asCommand } from "./commands.ts";
import { extractDocument } from "./extract.ts";
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
  options: { deposit_percent: null, pass_fees_to_client: null, vat_percent: null, notes: null },
  confidence,
});

export async function parseMessage(
  text: string,
  opts: { today?: Civil; fetchImpl?: typeof fetch } = {},
): Promise<ParseOutcome> {
  const started = Date.now();
  const since = () => Date.now() - started;
  const today = opts.today ?? todayIn(defaults.behaviour.timezone);

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
    return { ok: true, parsed: normalise(raw, today, "command"), latencyMs: since() };
  }

  /* 2. The sentence the product teaches. ----------------------------------- */
  const pattern = extractDocument(text, today);
  if (pattern && !pattern.missing.length) {
    return { ok: true, parsed: pattern, latencyMs: since() };
  }

  /* 3. The model. ---------------------------------------------------------- */
  const model = await parseWithModel(text, today, opts.fetchImpl);
  if (model.ok) {
    const parsed = normalise(model.parse, today, "model");

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
      return { ok: true, parsed: { ...parsed, intent: "unknown" }, latencyMs: since() };
    }

    return { ok: true, parsed, latencyMs: since() };
  }

  // A partial pattern match is better than nothing: it knows what it is
  // missing, and asking for that one thing is exactly what F3 wants.
  if (pattern) return { ok: true, parsed: pattern, latencyMs: since() };

  // Nothing read it. No key configured and the model being down are different
  // problems for us and the same problem for the user, so they get one answer
  // and the log gets the distinction.
  return { ok: false, reason: "unavailable", latencyMs: since() };
}

/** Whether document creation can work at all right now (section 15). */
export const canParseDocuments = (): boolean => modelConfigured();
