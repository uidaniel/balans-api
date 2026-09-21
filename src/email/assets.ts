/**
 * Brand files the emails carry with them.
 *
 * The mark is read from disk once and kept as base64, because every message
 * attaches the same bytes and re-reading a 16KB file per send is pointless.
 *
 * It travels with the message rather than being fetched from a URL: Gmail and
 * Outlook block remote images by default, so a hosted logo shows as an empty
 * box on first open for most people. It also means the emails do not wait on
 * the marketing site being deployed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "balans-mark.png");

let cached: string | undefined;

/** The mark as base64, for an attachment's `content` field. */
export function markAttachment(): string {
  if (cached) return cached;
  cached = readFileSync(MARK).toString("base64");
  return cached;
}
