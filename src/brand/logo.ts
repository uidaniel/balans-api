/**
 * The Balans logo, for anything the server renders.
 *
 * Read from disk once and held, because the pages that use it are built as
 * strings on a request and must not touch the filesystem to do it.
 *
 * Inlined as SVG markup rather than linked, for the same reason everything
 * else on the public page is inline: the page is opened by a stranger on a
 * phone, and a logo that arrives as a second request is a logo that sometimes
 * does not arrive. Inline also means the PDF renderer never has to fetch
 * anything, which is what keeps a render from hanging on a network call.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "..", "assets");

function read(name: string): string {
  try {
    return readFileSync(join(assets, name), "utf8").trim();
  } catch {
    // A missing asset must not take a payment page down. The caller falls
    // back to the wordmark in text.
    return "";
  }
}

let fullLogo: string | undefined;
let markOnly: string | undefined;

/**
 * The full logo: coin and wordmark, for light backgrounds.
 *
 * Sized by the caller through `height`, because the same file appears at
 * 28px on a web page and 14mm on an A4 sheet. The viewBox carries the aspect
 * ratio, so setting one dimension is enough and setting both would squash it.
 */
export function logoSvg(height: string): string {
  fullLogo ??= read("balans-logo.svg");
  if (!fullLogo) return "";
  return fullLogo
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, ` height="${height}"`)
    .replace("<svg", `<svg style="height:${height};width:auto;display:block"`);
}

/** The coin alone, where there is no room for the wordmark. */
export function markSvg(size: string): string {
  markOnly ??= read("balans-mark.svg");
  if (!markOnly) return "";
  return markOnly
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "")
    .replace("<svg", `<svg style="height:${size};width:${size};display:block"`);
}

/** Whether the files were found, so a caller can fall back rather than guess. */
export const logoAvailable = (): boolean => logoSvg("1px") !== "";

/** The processors whose marks can appear on a payment page. */
export type Processor = "monnify" | "paystack";

const processorMarks = new Map<Processor, string>();

/**
 * A processor's own mark, inlined as a data URI.
 *
 * Their files are PNGs rather than SVG, so this is base64 rather than markup
 * — about 16KB, which is worth paying once on a page whose entire job is to
 * be trusted with money. Inlined for the same reason as everything else here:
 * a badge that arrives as a second request is a badge that sometimes does
 * not, and a payment page missing its processor's mark looks worse than one
 * that never claimed it.
 *
 * Which mark is not a detail. Naira is collected by Monnify and anything else
 * by Paystack (International PRD section 8), and this badge is the one place
 * the page tells a stranger who is about to take their card details where
 * those details are going. Naming the wrong company there is worse than
 * naming none: it is checkable, and it will not check out.
 *
 * An empty string when the file is missing, so the caller can fall back to
 * the name in text rather than render a broken image.
 */
export function processorLogo(processor: Processor): string {
  let mark = processorMarks.get(processor);
  if (mark === undefined) {
    try {
      mark = readFileSync(join(assets, `${processor}.png`)).toString("base64");
    } catch {
      mark = "";
    }
    processorMarks.set(processor, mark);
  }
  return mark ? `data:image/png;base64,${mark}` : "";
}
