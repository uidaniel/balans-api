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
  | { ok: false; reason: "half"; position: number; hasDescription: boolean };

/** Field names for every slot, first included, in screen order. */
export function itemSlots(): { description: string; amount: string }[] {
  return [{ description: "description", amount: "amount" }, ...EXTRA_ITEMS.map(itemFields)];
}

export function linesFromForm(fields: Record<string, string>): FormLines {
  const lines: FormLine[] = [];

  for (const [index, slot] of itemSlots().entries()) {
    const description = (fields[slot.description] ?? "").trim();
    const rawAmount = String(fields[slot.amount] ?? "").trim();

    // An amount field can come back as "0" from a number input somebody
    // opened and left, which is not a line worth billing and not an error.
    const kobo = rawAmount ? parseAmountToKobo(rawAmount) : null;
    const hasAmount = kobo !== null && kobo > 0;

    if (!description && !hasAmount) continue;

    if (!description || !hasAmount) {
      return { ok: false, reason: "half", position: index + 1, hasDescription: Boolean(description) };
    }

    lines.push({ description, qty: 1, unitAmountKobo: kobo });
  }

  return lines.length ? { ok: true, lines } : { ok: false, reason: "nothing" };
}

/** What the lines add up to, before VAT. */
export const totalOfLines = (lines: FormLine[]): number =>
  lines.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0);
