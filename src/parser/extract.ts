/**
 * The canonical invoice sentence, read without a model.
 *
 *   "Invoice Zenith Homes 350k for duplex 3D render, due Friday"
 *
 * The PRD gives that exact sentence three times, and it is the shape the
 * landing page teaches. It will be most of the traffic. Reading it here costs
 * nothing, answers instantly, and keeps working on the day the model does not
 * — which section 15 asks for anyway.
 *
 * This is deliberately narrow. It requires a leading verb *and* a readable
 * amount, and returns null for anything else rather than half-understanding
 * it. Half-understanding is the failure that ends with a wrong number on a
 * real invoice; the model handles everything this will not touch.
 *
 * Even so, nothing here creates a document. Everything goes through
 * draft-and-confirm (F6), so the worst case is a draft the user corrects.
 */

import type { Civil } from "../../core/dates.ts";
import { normalise, type Intent, type Parsed, type RawParse } from "./schema.ts";

/** The verb decides the document type, so it is required. */
const VERB =
  /^(?:abeg\s+|please\s+|pls\s+|oya\s+|make\s+you\s+)?(?:send\s+|create\s+|make\s+|raise\s+|prepare\s+|generate\s+|draft\s+)?(invoice|bill|charge|quote|quotation|estimate)\s+(?:for\s+|to\s+)?/i;

const QUOTE_VERBS = new Set(["quote", "quotation", "estimate"]);

/**
 * An amount as people write it here: "350k", "1.2m", "N5,000", "₦350000",
 * "5h", "20000". A bare number needs four digits to count, so the "2" in
 * "2 logos" is never mistaken for two kobo.
 */
const AMOUNT =
  /(?:₦|n(?=\s?[\d])|ngn\s?)?\s?(\d[\d,]*(?:\.\d+)?)\s?([hkm])?\b/gi;

/** Where the date starts. Everything after it belongs to the date, not the work. */
const DUE = /[,;]?\s*\b(?:due|deadline|payable|by|before|not later than|within)\b\s*:?\s*/i;

const DEPOSIT = /[,;]?\s*\b(?:(\d{1,3})\s*%\s*(?:deposit|upfront|down|advance)|(?:deposit|upfront|advance)\s*(?:of\s*)?(\d{1,3})\s*%)\b/i;
const VAT = /[,;]?\s*\b(?:add\s+|with\s+|plus\s+|include\s+)?vat\b(?:\s*(?:at\s*)?(\d{1,2}(?:\.\d)?)\s*%)?/i;
const PASS_FEES = /[,;]?\s*\b(?:client|customer|they|he|she|them)\s+(?:should\s+|will\s+|go\s+|dey\s+)?pays?\s+(?:the\s+)?(?:fees?|charges?|transaction\s+fees?)\b/i;

/** Nigeria's rate. Named rather than inlined so there is one place to change it. */
const VAT_PERCENT = 7.5;

export function extractDocument(text: string, today: Civil): Parsed | null {
  const norm = text.replace(/\s+/g, " ").trim();
  // Indices are taken from the lowercased copy and used to slice the original,
  // so the client's name keeps its capitals. That only holds while the two are
  // the same length, which is true for everything but a few exotic scripts.
  const lower = norm.toLowerCase();
  if (lower.length !== norm.length) return null;

  const verb = VERB.exec(lower);
  if (!verb) return null;

  const intent: Intent = QUOTE_VERBS.has(verb[1]!.toLowerCase())
    ? "create_quote"
    : "create_invoice";

  let rest = norm.slice(verb[0].length);
  let restLower = rest.toLowerCase();

  /* Options come off first: each is a fixed phrase that would otherwise end up
     inside the description. ------------------------------------------------ */
  let depositPercent: number | null = null;
  let vatPercent: number | null = null;
  let passFees: boolean | null = null;

  const cut = (re: RegExp, onMatch: (m: RegExpExecArray) => void): void => {
    const m = re.exec(restLower);
    if (!m) return;
    onMatch(m);
    rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    restLower = rest.toLowerCase();
  };

  cut(DEPOSIT, (m) => {
    depositPercent = Number(m[1] ?? m[2]);
  });
  cut(PASS_FEES, () => {
    passFees = true;
  });
  cut(VAT, (m) => {
    vatPercent = m[1] ? Number(m[1]) : VAT_PERCENT;
  });

  /* Then the date, which owns everything after it. ------------------------- */
  let duePhrase: string | null = null;
  const due = DUE.exec(restLower);
  if (due) {
    const after = rest.slice(due.index + due[0].length).trim();
    // "by" also means "made by", so a due clause with nothing date-shaped
    // after it is left alone rather than swallowing the description.
    if (after) {
      duePhrase = after.replace(/[.!?]+$/, "").trim();
      rest = rest.slice(0, due.index).trim();
      restLower = rest.toLowerCase();
    }
  }

  /* Then the amount, which splits the client from the work. ---------------- */
  const amount = pickAmount(rest);
  if (!amount) return null;

  const before = rest.slice(0, amount.start).trim();
  const after = rest.slice(amount.end).trim();

  // Usually "<client> <amount> for <work>", but "bill 20k to Tunde for logo"
  // happens too, and then the name is on the other side.
  let clientPart = before;
  let workPart = after;
  if (!clientPart && after) {
    const to = /^(?:for|to)\s+/i.exec(after);
    if (to) {
      const tail = after.slice(to[0].length);
      const split = /\s+for\s+/i.exec(tail);
      clientPart = split ? tail.slice(0, split.index) : tail;
      workPart = split ? tail.slice(split.index + split[0].length) : "";
    }
  }

  const clientName = cleanClient(clientPart);
  if (!clientName) return null;

  const description = cleanDescription(workPart);

  const raw: RawParse = {
    intent,
    client_name: clientName,
    client_email: null,
    line_items: description ? [{ description, qty: 1, unit_amount: amount.raw }] : [],
    total_amount: description ? null : amount.raw,
    due_date: duePhrase,
    document_number: null,
    options: {
      deposit_percent: depositPercent,
      pass_fees_to_client: passFees,
      vat_percent: vatPercent,
      notes: null,
    },
    // High, but not certain: the shape matched, and the confirm step is still
    // what stands between this and a document.
    confidence: description ? 0.95 : 0.8,
  };

  return normalise(raw, today, "pattern");
}

/* -------------------------------------------------------------------------- */

type Found = { raw: string; start: number; end: number };

/**
 * Picks the amount out of a sentence that may hold several numbers.
 *
 * "2 banners 50k each" has a 2 and a 50k. The one with a suffix or a currency
 * mark is the money; a bare number only qualifies at four digits, which is
 * ₦1,000 — the smallest invoice the limits allow anyway.
 */
function pickAmount(s: string): Found | null {
  AMOUNT.lastIndex = 0;
  const candidates: (Found & { rank: number })[] = [];

  for (let m = AMOUNT.exec(s); m; m = AMOUNT.exec(s)) {
    const [whole, digits, suffix] = m;
    const marked = /^[₦n]|ngn/i.test(whole.trim());
    const plain = (digits ?? "").replace(/,/g, "").replace(/\..*$/, "");

    let rank = 0;
    if (marked) rank = 3;
    else if (suffix) rank = 2;
    else if (plain.length >= 4) rank = 1;
    if (!rank) continue;

    candidates.push({
      raw: whole.trim(),
      start: m.index + (whole.length - whole.trimStart().length),
      end: m.index + whole.length,
      rank,
    });
  }

  if (!candidates.length) return null;
  // Best rank, and the earliest of those: "50k each for 2 banners" states the
  // unit price first.
  candidates.sort((a, b) => b.rank - a.rank || a.start - b.start);
  const { raw, start, end } = candidates[0]!;
  return { raw, start, end };
}

/** "to Tunde", "for Zenith Homes:", "my client Tunde" -> the name. */
function cleanClient(s: string): string | null {
  const name = s
    .replace(/^(?:for|to|the|my client|client|customer)\s+/i, "")
    .replace(/[,:;]+$/, "")
    .replace(/\s+(?:for|of)$/i, "")
    .trim();
  // A name is one to five words. Longer and this was not the shape we thought.
  if (!name || name.length > 80) return null;
  if (name.split(" ").length > 5) return null;
  // A "name" that is only digits is the tail of an amount we misread.
  if (/^[\d\s,.]+$/.test(name)) return null;
  return name;
}

function cleanDescription(s: string): string | null {
  const d = s
    .replace(/^(?:for|on|covering|re|regarding)\s+/i, "")
    .replace(/^[,:;-]\s*/, "")
    .replace(/[,.;:]+$/, "")
    .trim();
  return d && d.length <= 200 ? d : null;
}
