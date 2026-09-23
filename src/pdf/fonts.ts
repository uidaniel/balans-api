/**
 * The brand's typefaces, for anything rendered as a sheet.
 *
 * The documents used to be set in whatever the host had — "Segoe UI" on a
 * laptop, DejaVu Sans in the container, and DejaVu is what every invoice
 * actually went out in. That is the single biggest reason the PDFs did not
 * look like the templates on balans.ng: the layouts were close, the type was
 * a different typeface at a different weight.
 *
 * So the faces travel with the repository. Instrument Sans for text and Geist
 * for the display numbers, which is exactly the pairing the web app loads;
 * Instrument Serif for Atelier, the one layout set in serif.
 *
 * Two ways to reach them, because the two callers have opposite constraints:
 *
 *   - `embed` inlines the bytes as data URIs. A PDF render is handed HTML with
 *     no origin and no network (see `renderPdf`), so a URL would simply not
 *     resolve. It costs about 400KB of base64 per render, which Chrome parses
 *     in a few milliseconds and subsets away in the PDF it produces.
 *   - `link` points at `/designs/fonts.css`. The picker shows eight sheets at
 *     once, and eight copies of the embedded bytes is several megabytes over
 *     a phone connection for the same eight files.
 *
 * Amounts are the one place a fallback still shows: neither Geist nor
 * Instrument Sans carries ₦ (U+20A6), so the sign comes from DejaVu, which is
 * installed in the image for exactly this reason. The browser does that per
 * glyph, so only the sign changes face — the digits beside it do not. The web
 * app falls back the same way, which is why the two match.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");

type Face = { family: string; weight: number; style: "normal" | "italic"; file: string };

/** The faces, grouped by the part of a sheet that needs them. */
const FACES = {
  sans: [
    { family: "Instrument Sans", weight: 400, style: "normal", file: "InstrumentSans-Regular.ttf" },
    { family: "Instrument Sans", weight: 600, style: "normal", file: "InstrumentSans-SemiBold.ttf" },
    { family: "Instrument Sans", weight: 700, style: "normal", file: "InstrumentSans-Bold.ttf" },
  ],
  display: [
    { family: "Geist", weight: 700, style: "normal", file: "Geist-Bold.ttf" },
    { family: "Geist", weight: 800, style: "normal", file: "Geist-ExtraBold.ttf" },
  ],
  serif: [
    { family: "Instrument Serif", weight: 400, style: "normal", file: "InstrumentSerif-Regular.ttf" },
    { family: "Instrument Serif", weight: 400, style: "italic", file: "InstrumentSerif-Italic.ttf" },
  ],
} satisfies Record<string, Face[]>;

export type FontSet = keyof typeof FACES;

/** Public name -> file, so the route serving these cannot be walked. */
export const FONT_FILES: Record<string, string> = Object.fromEntries(
  Object.values(FACES)
    .flat()
    .map((f) => [f.file, path.join(DIR, f.file)]),
);

/**
 * The stacks themselves.
 *
 * DejaVu and Liberation are in the container; the rest are for a developer's
 * laptop. The last resort is a naked `sans-serif`, which still renders a
 * readable invoice — it just is not ours.
 */
export const FONT = {
  sans: `"Instrument Sans","DejaVu Sans","Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif`,
  display: `"Geist","Instrument Sans","DejaVu Sans","Segoe UI",-apple-system,Arial,sans-serif`,
  serif: `"Instrument Serif","DejaVu Serif",Georgia,"Times New Roman",serif`,
};

/* Read once. The same seven files are wanted on every render, and base64 of
   400KB is not work worth repeating a few hundred times a day. */
const cache = new Map<string, string>();

function dataUri(file: string): string {
  let uri = cache.get(file);
  if (!uri) {
    uri = `data:font/ttf;base64,${readFileSync(path.join(DIR, file)).toString("base64")}`;
    cache.set(file, uri);
  }
  return uri;
}

const face = (f: Face, src: string): string =>
  `@font-face{font-family:"${f.family}";font-style:${f.style};font-weight:${f.weight};` +
  `font-display:block;src:url(${src}) format("truetype")}`;

/**
 * `@font-face` rules for the sets a sheet actually uses.
 *
 * Asking for only what is used matters: Atelier is the one layout in serif,
 * and the other seven have no reason to carry 126KB of it.
 */
export function fontFaces(sets: FontSet[], mode: "embed" | "link" = "embed"): string {
  if (mode === "link") return "";
  return sets
    .flatMap((set) => FACES[set].map((f) => face(f, dataUri(f.file))))
    .join("");
}

/** The same rules as a stylesheet, for pages that can fetch one. */
export function fontStylesheet(base = "/designs/fonts"): string {
  return Object.values(FACES)
    .flat()
    .map((f) => face(f, `${base}/${f.file}`))
    .join("\n");
}
