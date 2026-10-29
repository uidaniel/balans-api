/**
 * The brand's typefaces, for anything rendered as a sheet.
 *
 * The documents used to be set in whatever the host had — "Segoe UI" on a
 * laptop, DejaVu Sans in the container, and DejaVu is what every invoice
 * actually went out in. That is the single biggest reason the PDFs did not
 * look like the templates on balans.ng: the layouts were close, the type was
 * a different typeface at a different weight.
 *
 * So the faces travel with the repository. Wix Madefor Display for everything
 * (20 October 2026; it replaced Instrument Sans for text and Geist for the
 * figures), which is what the web app loads; Instrument Serif for Atelier,
 * the one layout set in serif.
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
 * Amounts are the one place a fallback still shows: Wix Madefor Display does
 * not carry ₦ (U+20A6), so the sign comes from DejaVu, which is
 * installed in the image for exactly this reason. The browser does that per
 * glyph, so only the sign changes face — the digits beside it do not. The web
 * app falls back the same way, which is why the two match.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");

type Face = { family: string; weight: number; style: "normal" | "italic"; file: string };

/*
 * One family for text and figures. `sans` and `display` stay apart as names,
 * because every sheet asks for them by role, and a role can move to another
 * face again without touching a layout.
 */
const WIX: Face[] = [
  { family: "Wix Madefor Display", weight: 400, style: "normal", file: "WixMadeforDisplay-Regular.ttf" },
  { family: "Wix Madefor Display", weight: 500, style: "normal", file: "WixMadeforDisplay-Medium.ttf" },
  { family: "Wix Madefor Display", weight: 600, style: "normal", file: "WixMadeforDisplay-SemiBold.ttf" },
  { family: "Wix Madefor Display", weight: 700, style: "normal", file: "WixMadeforDisplay-Bold.ttf" },
  { family: "Wix Madefor Display", weight: 800, style: "normal", file: "WixMadeforDisplay-ExtraBold.ttf" },
];

/*
 * Onest, the brand's face since the rebrand (29 October 2026): balans.ng, the
 * posters and the cards the bot sends in chat. The invoices stay in Wix
 * Madefor Display; a sheet is somebody else's document, not our poster.
 */
const ONEST: Face[] = [300, 400, 500, 600].map((weight) => ({
  family: "Onest",
  weight,
  style: "normal" as const,
  file: `Onest-${weight}.ttf`,
}));

/** The faces, grouped by the part of a sheet that needs them. */
const FACES = {
  brand: ONEST,
  sans: WIX,
  display: WIX,
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
  sans: `"Wix Madefor Display","DejaVu Sans","Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif`,
  display: `"Wix Madefor Display","DejaVu Sans","Segoe UI",-apple-system,Arial,sans-serif`,
  serif: `"Instrument Serif","DejaVu Serif",Georgia,"Times New Roman",serif`,
  brand: `"Onest","DejaVu Sans","Segoe UI",-apple-system,Arial,sans-serif`,
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

/** The faces of these sets, each once: `sans` and `display` share a family. */
const facesOf = (sets: FontSet[]): Face[] => [...new Set(sets.flatMap((set) => FACES[set]))];

const face = (f: Face, src: string, display: "block" | "swap" = "block"): string =>
  `@font-face{font-family:"${f.family}";font-style:${f.style};font-weight:${f.weight};` +
  `font-display:${display};src:url("${src}") format("truetype")}`;

/**
 * `@font-face` rules for the sets a sheet actually uses.
 *
 * Asking for only what is used matters: Atelier is the one layout in serif,
 * and the other seven have no reason to carry 126KB of it.
 */
export function fontFaces(sets: FontSet[], mode: "embed" | "link" = "embed"): string {
  if (mode === "link") return "";
  return facesOf(sets)
    .map((f) => face(f, dataUri(f.file)))
    .join("");
}

/** The same rules as a stylesheet, for pages that can fetch one. */
export function fontStylesheet(base = "/designs/fonts"): string {
  return facesOf(Object.keys(FACES) as FontSet[])
    .map((f) => face(f, `${base}/${f.file}`))
    .join("\n");
}

/**
 * Rules for a page a person reads, rather than a sheet that is captured.
 *
 * `swap`, not `block`. A capture waits for the faces and must not show a
 * fallback; a person on a slow connection should read the invoice in the
 * phone's own font for a second rather than stare at a blank page for three.
 * Inlined by the caller, so the only requests are for the faces a browser
 * actually uses on that page.
 */
export function fontFacesForPage(sets: FontSet[], base = "/designs/fonts"): string {
  return facesOf(sets).map((f) => face(f, `${base}/${f.file}`, "swap")).join("");
}

/**
 * Every embedded font, keyed by the data URI a sheet carries it as, to the
 * file it came from. The renderer uses this to load the same bytes from a
 * cache instead of decoding half a megabyte of base64 on every render.
 */
export function embeddedFonts(): Map<string, string> {
  return new Map(Object.keys(FONT_FILES).map((file) => [dataUri(file), file]));
}
