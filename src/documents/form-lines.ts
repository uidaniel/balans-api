/**
 * The line items a submitted invoice or quote form came back with.
 *
 * The form used to collect one description and one amount, so an invoice with
 * three things on it could only be written as a sentence or squeezed into a
 * single line — "logo, website and business cards" at one price, which is not
 * what anybody was billing for and not what the client wanted to read.
 *
 * The Flow now carries five slots. Four of them are optional and hidden
 * behind checkboxes, so what arrives here is a sparse set of fields with gaps
 * in it, in a fixed order.
 *
 * The rule that matters is the one about half-finished items. Somebody who
 * ticks "Add another item", types "Business cards" and taps Next without an
 * amount has told us about work they mean to bill for. Dropping it quietly
 * would send an invoice that is short by however much those cards cost, and
 * nothing on screen would say so. So a half-filled slot stops the form and
 * says which one, and an untouched slot is simply not an item.
 *
 * Quantity is optional and empty means one. With a quantity, the amount is
 * the price of one, which is how the sentence has always read "4 stills at
 * 20k" and how every template prints a line. A quantity on its own is a
 * half-filled slot like any other, and one that is not a usable number stops
 * the form rather than being read as one: "2 or 3" billed as one would be an
 * invoice short by however much the other one or two cost.
 */

import { parseAmountToKobo } from "../../core/amount.ts";
import { EXTRA_ITEMS, itemFields } from "../whatsapp/flows/definitions.ts";

export type FormLine = { description: string; qty: number; unitAmountKobo: number };

export type FormLines =
  /** At least one complete item, in the order they were filled in. */
  | { ok: true; lines: FormLine[] }
  /** Nothing usable at all — the first item is the required one. */
  | { ok: false; reason: "nothing" }
  /**
   * One slot has words but no money, or money but no words.
   *
   * `position` is 1-based and counts every slot, filled or not, so it is the
   * number somebody sees when they look back at the form.
   */
  | { ok: false; reason: "half"; position: number; hasDescription: boolean }
  /** A slot's quantity is not a number we can bill: zero, negative, words, too many. */
  | { ok: false; reason: "qty"; position: number };

/** The most of anything one line bills, the same ceiling the sentence has (schema.ts). */
export const MAX_QTY = 10_000;

/** Field names for every slot, first included, in screen order. */
export function itemSlots(): { description: string; qty: string; amount: string }[] {
  return [{ description: "description", qty: "qty", amount: "amount" }, ...EXTRA_ITEMS.map(itemFields)];
}

/**
 * A quantity box, read.
 *
 * Empty and "0" are both "not set": a number input somebody opened and left
 * can come back as "0", exactly as an amount can. Up to three decimal places,
 * because hours and metres are billed in halves and the column holds three.
 */
function readQty(raw: string): number | "unset" | "bad" {
  const s = raw.trim().replace(/,/g, "");
  if (!s || /^0+(\.0*)?$/.test(s)) return "unset";
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return "bad";
  const n = Number(s);
  return n > 0 && n <= MAX_QTY ? n : "bad";
}

export function linesFromForm(fields: Record<string, string>): FormLines {
  const lines: FormLine[] = [];

  for (const [index, slot] of itemSlots().entries()) {
    const description = (fields[slot.description] ?? "").trim();
    const rawAmount = String(fields[slot.amount] ?? "").trim();
    const qty = readQty(String(fields[slot.qty] ?? ""));

    // An amount field can come back as "0" from a number input somebody
    // opened and left, which is not a line worth billing and not an error.
    const kobo = rawAmount ? parseAmountToKobo(rawAmount) : null;
    const hasAmount = kobo !== null && kobo > 0;

    if (!description && !hasAmount && qty === "unset") continue;

    if (!description || !hasAmount) {
      return { ok: false, reason: "half", position: index + 1, hasDescription: Boolean(description) };
    }

    if (qty === "bad") return { ok: false, reason: "qty", position: index + 1 };

    lines.push({ description, qty: qty === "unset" ? 1 : qty, unitAmountKobo: kobo });
  }

  return lines.length ? { ok: true, lines } : { ok: false, reason: "nothing" };
}

/** What the lines add up to, before VAT. */
export const totalOfLines = (lines: FormLine[]): number =>
  lines.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0);
