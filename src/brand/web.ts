/**
 * The brand, for the pages the bot opens (29 October 2026).
 *
 * The same look as balans.ng and the cards in the chat: a night-green band
 * with one soft marigold light from the top right, the coin logo with the
 * Onest wordmark, light Onest headings in two tones, white panels on cream
 * and gold pill buttons. Shared here so the settings page, the summary, the
 * design picker, the signature pad and the identity check cannot drift apart.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/brand/art");

const files = new Map<string, string | null>();

function inline(file: string, height: string): string {
  if (!files.has(file)) {
    try {
      files.set(file, readFileSync(path.join(ART, file), "utf8"));
    } catch {
      files.set(file, null);
    }
  }
  const svg = files.get(file);
  if (!svg) return `<span style="font-weight:600;font-size:${height}">balans</span>`;
  const cropped = svg
    .replace(/\swidth="[^"]*"/, ' width="417.9"')
    .replace(/\sheight="[^"]*"/, ' height="120"')
    .replace(/viewBox="[^"]*"/, 'viewBox="20 20 417.9 120"');
  return `<img src="data:image/svg+xml;base64,${Buffer.from(cropped).toString("base64")}" alt="Balans" style="height:${height};width:auto;display:block">`;
}

/**
 * The logo for a dark band, inline: gold coin, cream wordmark.
 *
 * Cropped to the drawing (the file carries 20 units of margin) so `height` is
 * the coin's height. An image from a base64 data URI rather than inline
 * markup: nothing to fetch, no URL in the page (the summary is tested to name
 * none), and the logo's own shapes stay out of the page's SVG charts.
 */
export const darkLogo = (height: string): string => inline("logo-dark.svg", height);

/** The same on cream or white: gold coin, ink wordmark. */
export const lightLogo = (height: string): string => inline("logo-light.svg", height);

/** The band's ground: night green, lit softly from the top right. */
export const BAND =
  "radial-gradient(120% 95% at 100% 0%,rgba(245,184,46,.2),rgba(245,184,46,.07) 38%,rgba(245,184,46,0) 68%),#08130f";

/** The gold pill, as on balans.ng. */
export const GOLD =
  "background:linear-gradient(180deg,#ffd877,#f5b82e);color:#10231c;" +
  "box-shadow:inset 0 1px 0 rgba(255,250,230,.6),0 8px 20px -10px rgba(245,184,46,.6)";
