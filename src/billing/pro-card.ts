/**
 * The Pro membership card, with the month they actually joined on it.
 *
 * The artwork reads "MEMBER SINCE SEP 2026", painted on. Everybody who
 * subscribes after September would get a card with the wrong month, and no
 * amount of code could fix a PNG.
 *
 * So the month is drawn over it. The design is the designed file — nothing is
 * recreated in CSS, because a hand-built copy would not match the type and
 * would drift from the artwork every time either changed. The only thing this
 * adds is a patch in the card's own colour over the old line, and the real
 * month in its place, rotated to sit on the card.
 *
 * Rendered through the same browser as the invoices, cached by month, and
 * served from the brand route. Twelve possible images a year, each built once.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng, rendererAvailable } from "../pdf/chrome.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/brand");

/** The artwork, read once. */
let artwork: string | null = null;
const base = (): string => {
  artwork ??= readFileSync(path.join(DIR, "pro.png")).toString("base64");
  return artwork;
};

/** The card is square, and this is its real size. */
export const SIZE = 2160;

// prettier-ignore
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/**
 * Where the line sits on the card, measured from the artwork.
 *
 * The card is tilted, so the patch and the text are tilted with it. These are
 * fractions of the image rather than pixels, so the numbers still mean
 * something if the artwork is ever exported at another size.
 */
const LINE = {
  /**
   * The card's tilt, in degrees.
   *
   * Measured off the artwork rather than guessed: the line runs from about
   * (490, 1095) to (1090, 1045) in the 2160px file, which is 4.8 degrees
   * anticlockwise. Guessing put it three degrees out and the patch landed on
   * the word PRO.
   */
  tilt: -4.8,
  /** Top-left of the patch, as a fraction of the whole image. */
  x: 475 / 2160,
  y: 1055 / 2160,
  w: 660 / 2160,
  h: 115 / 2160,
  /** Type size, from a measured cap height of 31px. */
  size: 43 / 2160,
};

/**
 * The card's own yellow.
 *
 * Sampled from the artwork, not taken from the brand sheet and hoped for:
 * every pixel around the line reads #F5B82E exactly, so a patch in it is
 * invisible. A near miss would show as a rectangle.
 */
const CARD = "#F5B82E";
const INK = "#10231C";

export function proCardHtml(month: number, year: number): string {
  const label = `MEMBER SINCE ${MONTHS[month - 1]} ${year}`;
  const pc = (n: number) => `${n * 100}%`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box }
  html, body { width: ${SIZE}px; height: ${SIZE}px; overflow: hidden }
  body {
    background: url(data:image/png;base64,${base()}) center/cover no-repeat;
    position: relative;
    font-family: "Segoe UI", Arial, Helvetica, sans-serif;
  }
  /* The old line, covered in the card's own colour. */
  .patch {
    position: absolute;
    left: ${pc(LINE.x)}; top: ${pc(LINE.y)};
    width: ${pc(LINE.w)}; height: ${pc(LINE.h)};
    background: ${CARD};
    transform: rotate(${LINE.tilt}deg);
    transform-origin: left top;
  }
  /* The real one, on the same plane. */
  .since {
    position: absolute;
    left: ${pc(LINE.x)}; top: ${pc(LINE.y)};
    height: ${pc(LINE.h)};
    display: flex; align-items: center;
    transform: rotate(${LINE.tilt}deg);
    transform-origin: left top;
    color: ${INK};
    font-size: ${SIZE * LINE.size}px;
    font-weight: 700;
    letter-spacing: 0.10em;
    white-space: nowrap;
  }
</style></head>
<body>
  <div class="patch"></div>
  <div class="since">${label}</div>
</body></html>`;
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

  const png = await renderPng(proCardHtml(month, year), SIZE, SIZE);
  cache.set(key, png);
  return png;
}
