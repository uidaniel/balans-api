/**
 * A Pro user's brand colour, and how it replaces ours.
 *
 * Every Balans surface a client sees is drawn in ink and one accent,
 * marigold. A brand colour is that accent swapped for theirs: the same
 * places, the same weight, so no layout needs to know about it. Two things
 * have to be worked out rather than swapped:
 *
 *   - What goes *on* the colour. Ink on marigold reads; ink on navy does not.
 *     `onColour` picks ink or white by contrast.
 *   - The deeper shade, used where marigold-deep sets a figure in colour on
 *     white paper. A pale brand colour as text on white would vanish, so
 *     `deepen` darkens it until it reads.
 */

export const MARIGOLD = "#F5B82E";
export const MARIGOLD_DEEP = "#D99A12";
const INK = "#10231C";
const WHITE = "#FFFFFF";

/** "#1a73e8", "1A73E8", "#1a7" → "#1A73E8"; anything else → null. */
export function normaliseHex(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")
      .toUpperCase()}`;
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toUpperCase()}` : null;
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Ink or white, whichever reads better on the colour. */
export function onColour(hex: string): string {
  return contrast(hex, INK) >= contrast(hex, WHITE) ? INK : WHITE;
}

/** The colour, darkened until it reads as text on white (3:1, large text). */
export function deepen(hex: string): string {
  let [r, g, b] = rgb(hex);
  let out = toHex(r, g, b);
  for (let i = 0; i < 20 && contrast(out, WHITE) < 3; i++) {
    r *= 0.9;
    g *= 0.9;
    b *= 0.9;
    out = toHex(r, g, b);
  }
  return out;
}

/** The colour mixed toward white: `amount` 0 is the colour, 1 is white. */
export function tint(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

/** Everything a layout needs to wear a brand colour. */
export type BrandTokens = {
  /** The colour itself, for fills and rules. */
  c: string;
  /** Text on a fill of it: ink or white. */
  on: string;
  /** The colour as text on white paper, darkened if it has to be. */
  deep: string;
  /** A pale wash of it, for a large area behind ink text. */
  wash: string;
};

export function brandTokens(hex: string | null | undefined): BrandTokens | null {
  const c = normaliseHex(hex);
  return c ? { c, on: onColour(c), deep: deepen(c), wash: tint(c, 0.86) } : null;
}

/**
 * A rendered page or document, recoloured.
 *
 * Replaces the two marigold hexes wherever they appear, in any case, and adds
 * one rule for the places where text sits on the accent. Anything that is
 * not marigold — ink, paper, the green of "paid" — is left as it is.
 */
export function applyBrand(html: string, brand: string | null | undefined): string {
  const colour = normaliseHex(brand);
  if (!colour) return html;
  const deep = deepen(colour);
  const on = onColour(colour);
  // With the "#", always: a page can carry fonts as base64, and six bare hex
  // digits could turn up inside that. A "#" never does.
  const swapped = html
    .replace(new RegExp(MARIGOLD, "gi"), colour)
    .replace(new RegExp(MARIGOLD_DEEP, "gi"), deep)
    // The pay page's lighter hover shade.
    .replace(/#ffc848/gi, colour);
  // The pay page's buttons: the one place outside a layout's own brand rules
  // (pdf/kit.ts `brand`) where words sit on the accent.
  const rule = `<style>button.pay-btn,a.pay-btn,button.tcopy{color:${on}!important}</style>`;
  return swapped.includes("</head>") ? swapped.replace("</head>", `${rule}</head>`) : swapped + rule;
}
