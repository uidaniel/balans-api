/**
 * Pictures the emails carry with them.
 *
 * Read from disk once and kept as base64, because every message attaches the
 * same bytes and re-reading a file per send is pointless.
 *
 * They travel with the message rather than being fetched from a URL: Gmail
 * and Outlook block remote images by default, so a hosted logo shows as an
 * empty box on first open for most people. It also means the emails do not
 * wait on the marketing site being deployed.
 *
 * The files are in assets/email: mark.png is assets/balans-mark.svg at three
 * times its size in the message, and each banner is drawn in the .html file
 * of the same name.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "email");

const cache = new Map<string, string>();

/** A file in assets/email as base64, for an attachment's `content` field. */
export function attachmentContent(file: string): string {
  let b64 = cache.get(file);
  if (!b64) {
    b64 = readFileSync(join(DIR, file)).toString("base64");
    cache.set(file, b64);
  }
  return b64;
}
