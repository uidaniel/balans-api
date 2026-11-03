/**
 * An email button's label, drawn as a picture (4 November 2026).
 *
 * The Gmail apps recolour text in dark mode, and no rule a sender writes stops
 * them: the dark label on the gold button came out white. A blended-layer
 * trick meant to undo that drew the label as bars instead. Gmail does not
 * recolour pictures, so the label is drawn here, see-through around the
 * letters so the gold shows behind, and the button carries the words as its
 * alt text, which is what anyone with pictures off still reads on the gold.
 *
 * Only the words and a colour are in the address, never who it is for: an
 * amount on its own says nothing about anyone. Drawn once per label and kept.
 */

import { env } from "../config.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng, rendererAvailable } from "../pdf/chrome.ts";

/** Twice the size it shows at, for sharp text on high-density screens. */
const SCALE = 2;
/** The label's line, in CSS pixels as the email shows it. */
export const LABEL_H = 22;
const FONT_PX = 15;
export const LABEL_MAX = 40;

/** Letters, numbers, spaces, currency signs and the punctuation an amount needs. */
const ALLOWED = /^[\p{L}\p{N} ₦$€£¥₵.,:'’()&+\-]{1,40}$/u;

export const validLabel = (text: string): boolean => ALLOWED.test(text);
export const validColour = (hex: string): boolean => /^[0-9A-Fa-f]{6}$/.test(hex);

/**
 * How wide to draw it, generously: the letters sit centred in a see-through
 * strip, so spare width costs nothing and too little would cut them off.
 */
export const labelWidth = (text: string): number => Math.min(420, Math.round(text.length * 9.6) + 16);

export function labelHtml(text: string, colour: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces(["brand"])}
html,body{margin:0;background:transparent}
body{width:${labelWidth(text) * SCALE}px;height:${LABEL_H * SCALE}px;display:flex;align-items:center;justify-content:center;
font-family:${FONT.brand};font-weight:500;font-size:${FONT_PX * SCALE}px;line-height:1;color:#${colour};
white-space:nowrap;-webkit-font-smoothing:antialiased}
</style></head><body>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</body></html>`;
}

const drawn = new Map<string, Promise<Buffer | null>>();
const KEEP = 500;

/** The label as a see-through PNG, or null when there is no renderer. */
export function buttonLabelPng(text: string, colour: string): Promise<Buffer | null> {
  const key = `${colour.toUpperCase()}|${text}`;
  const had = drawn.get(key);
  if (had) return had;
  if (!rendererAvailable()) return Promise.resolve(null);
  const job = renderPng(labelHtml(text, colour), labelWidth(text) * SCALE, LABEL_H * SCALE, { transparent: true }).catch(
    () => {
      drawn.delete(key);
      return null;
    },
  );
  if (drawn.size >= KEEP) drawn.delete(drawn.keys().next().value!);
  drawn.set(key, job);
  return job;
}

export function buttonLabelUrl(text: string, colour: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/brand/label.png?t=${encodeURIComponent(text)}&c=${colour.replace(/^#/, "").toUpperCase()}`;
}
