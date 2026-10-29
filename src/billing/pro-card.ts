/**
 * The Pro membership card, with the month they actually joined on it.
 *
 * The card is drawn in brand/cards.ts: a brushed gold card made in Google
 * Flow, with the coin, "PRO" and "Member since <month>" engraved into it on
 * the card's own plane. Until 29 October 2026 the month was painted into a
 * PNG and patched over in the card's yellow; now it is simply part of the
 * drawing, so there is nothing to cover.
 *
 * Rendered through the same browser as the invoices, cached by month, and
 * served from the brand route. Twelve possible images a year, each built once.
 */

import { CARD_W, SQUARE, proCardHtml as draw } from "../brand/cards.ts";
import { renderPng, rendererAvailable } from "../pdf/chrome.ts";

/** The card is square, and this is its real size. */
export const SIZE = SQUARE;

export function proCardHtml(month: number, year: number): string {
  return draw(month, year);
}

/**
 * The card for a given month, built once and kept.
 *
 * Keyed by month because that is all that varies. Twelve images a year, and
 * in practice one or two live at a time.
 */
const cache = new Map<string, Buffer>();

export async function proCard(month: number, year: number): Promise<Buffer | null> {
  if (!rendererAvailable()) return null;

  const key = `${year}-${month}`;
  const had = cache.get(key);
  if (had) return had;

  const jpg = await renderPng(proCardHtml(month, year), CARD_W, SIZE, { jpeg: true });
  cache.set(key, jpg);
  return jpg;
}
