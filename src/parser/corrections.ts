/**
 * Corrections to a draft on screen (PRD F6 step 3).
 *
 * "User can confirm, reject, or correct in plain language ('make it 400k',
 * 'due next Friday'). Corrections update the draft and re-show the summary."
 *
 * Read here rather than by the model, for the same reason "yes" is: the draft
 * is already correct, and the only thing a correction can do is make it wrong.
 * A narrow reader that returns null for anything it is not sure about hands
 * the odd case to the model, which is the right trade when the common cases
 * are five fixed shapes.
 */

import { parseAmountToKobo } from "../../core/amount.ts";
import { resolveDueDate, type Civil } from "../../core/dates.ts";
import { COUNTED, SPREAD, countOf } from "./extract.ts";

export type Correction = {
  totalKobo?: number;
  dueDate?: Civil;
  /** The phrase, so the summary can echo how they said it. */
  duePhrase?: string;
  clientName?: string;
  description?: string;
  vatPercent?: number | null;
  depositPercent?: number | null;
  instalments?: number | null;
  passFeesToClient?: boolean;
};

/** Verbs that mean "replace this", not "add this". */
const CHANGE = String.raw`(?:make it|change it to|change to|change|set it to|set to|it(?:'| i)?s|its|should be|update to|no,? )`;

const AMOUNT_ONLY =
  /^(?:make it|change it to|change to|set it to|set to|it should be|should be|no,?\s*)?\s*(?:₦|n|ngn)?\s?(\d[\d,]*(?:\.\d+)?\s?[hkm]?)\s*(?:instead|abeg|please|o)?$/i;

const AMOUNT_LABELLED =
  /(?:amount|total|price|it|cost)\s+(?:should be|is|to)\s+(?:₦|n|ngn)?\s?(\d[\d,]*(?:\.\d+)?\s?[hkm]?)\b/i;

const DUE = /\b(?:due|deadline|payable|pay(?:able)? by)\s*:?\s*(.+)$/i;
const DUE_CHANGE = new RegExp(String.raw`\b(?:${CHANGE})\s*due\s*:?\s*(.+)$`, "i");

const CLIENT =
  /\b(?:(?:client|name|customer)\s+(?:should be|is|to)|it(?:'|’)?s for|for)\s+([A-Za-z][A-Za-z0-9 .'&-]{1,60})$/i;

const DESCRIPTION = /\b(?:description|for|it(?:'|’)?s for|work|service)\s+(?:should be|is)\s+(.+)$/i;

const ADD_VAT = /\b(?:add|include|with|plus)\s+vat(?:\s*(?:at\s*)?(\d{1,2}(?:\.\d)?)\s*%)?/i;
const NO_VAT = /\b(?:no|remove|without|drop|take off)\s+(?:the\s+)?vat\b/i;
const DEPOSIT = /\b(?:(\d{1,3})\s*%\s*(?:deposit|upfront|down)|(?:deposit|upfront)\s*(?:of\s*)?(\d{1,3})\s*%)\b/i;
const NO_DEPOSIT = /\b(?:no|remove|without|drop)\s+(?:the\s+)?deposit\b/i;
const NO_INSTALMENTS =
  /\b(?:no|remove|without|drop|forget|cancel)\s+(?:the\s+)?(?:instal|install|milestone|payment plan)\w*\b|\b(?:one|1|single|full)\s+payments?\b/i;
const PASS_FEES = /\b(?:client|customer|they|them)\s+(?:should\s+|will\s+|go\s+|dey\s+)?pays?\s+(?:the\s+)?(?:fees?|charges?)\b/i;
const NO_PASS_FEES = /\bi(?:'| a)?ll?\s+pay\s+(?:the\s+)?(?:fees?|charges?)\b|\bi\s+pay\s+(?:the\s+)?fees?\b/i;

const VAT_DEFAULT = 7.5;

/**
 * Reads a message as a change to the draft, or returns null.
 *
 * Several things can change at once — "make it 400k, due next Friday" is one
 * message — so every rule is tried and the result is whatever they matched.
 */
export function readCorrection(text: string, today: Civil): Correction | null {
  const s = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!s || s.length > 200) return null;

  const out: Correction = {};
  let rest = s;

  /* The date first: it owns everything after "due", which would otherwise be
     read as a description. ------------------------------------------------- */
  const dueMatch = DUE_CHANGE.exec(rest) ?? DUE.exec(rest);
  if (dueMatch) {
    const resolved = resolveDueDate(dueMatch[1]!, today);
    if (resolved) {
      out.dueDate = resolved.date;
      out.duePhrase = dueMatch[1]!.trim();
      rest = rest.slice(0, dueMatch.index).trim().replace(/[,;]+$/, "");
    }
  }

  /* Options, each a fixed phrase. ------------------------------------------ */
  if (NO_VAT.test(rest)) {
    out.vatPercent = null;
    rest = rest.replace(NO_VAT, "").trim();
  } else {
    const vat = ADD_VAT.exec(rest);
    if (vat) {
      out.vatPercent = vat[1] ? Number(vat[1]) : VAT_DEFAULT;
      rest = rest.replace(ADD_VAT, "").trim();
    }
  }

  if (NO_DEPOSIT.test(rest)) {
    out.depositPercent = null;
    rest = rest.replace(NO_DEPOSIT, "").trim();
  } else {
    const deposit = DEPOSIT.exec(rest);
    if (deposit) {
      out.depositPercent = Number(deposit[1] ?? deposit[2]);
      rest = rest.replace(DEPOSIT, "").trim();
    }
  }

  /*
   * A deposit and instalments are two answers to one question.
   *
   * So asking for either clears the other. Without that, "actually make it 3
   * payments" would leave an earlier 50% deposit in place, and `shapeFor`
   * prefers the deposit — the draft would come back showing a split the user
   * had just replaced.
   */
  if (NO_INSTALMENTS.test(rest)) {
    out.instalments = null;
    rest = rest.replace(NO_INSTALMENTS, "").trim();
  } else {
    for (const re of [SPREAD, COUNTED]) {
      const m = re.exec(rest);
      const n = m ? countOf(m[1]) : null;
      if (n === null) continue;
      out.instalments = n;
      out.depositPercent = null;
      rest = rest.replace(re, "").trim();
      break;
    }
  }
  if (out.depositPercent != null) out.instalments = null;

  if (NO_PASS_FEES.test(rest)) {
    out.passFeesToClient = false;
    rest = rest.replace(NO_PASS_FEES, "").trim();
  } else if (PASS_FEES.test(rest)) {
    out.passFeesToClient = true;
    rest = rest.replace(PASS_FEES, "").trim();
  }

  rest = rest.replace(/^[,;]\s*/, "").replace(/[,;]+$/, "").trim();

  /* Then the amount, which is the change that matters most. ---------------- */
  const labelled = AMOUNT_LABELLED.exec(rest);
  const bare = labelled ? null : AMOUNT_ONLY.exec(rest);
  const amountText = labelled?.[1] ?? bare?.[1];
  if (amountText) {
    const kobo = parseAmountToKobo(amountText);
    // A bare number under ₦1,000 is far more likely a quantity or a typo than
    // a total; the limits reject it anyway, so asking is better than guessing.
    if (kobo !== null && kobo >= 1_000_00) {
      out.totalKobo = kobo;
      rest = "";
    }
  }

  /* Whatever is left may name the client or the work. ---------------------- */
  if (rest) {
    const described = DESCRIPTION.exec(rest);
    if (described) {
      const d = clean(described[1]!);
      if (d) out.description = d;
    } else {
      const client = CLIENT.exec(rest);
      if (client) {
        const name = clean(client[1]!);
        // Names are short. Anything longer is a sentence we misread.
        if (name && name.split(" ").length <= 5) out.clientName = name;
      }
    }
  }

  return Object.keys(out).length ? out : null;
}

const clean = (s: string): string | null => {
  const t = s.trim().replace(/^["'“]|["'”]$/g, "").replace(/[,;:]+$/, "").trim();
  return t && t.length <= 200 ? t : null;
};
