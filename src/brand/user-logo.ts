/**
 * The user's own logo on their invoices (F21, Pro).
 *
 * Advertised on the pricing table since before it worked: "Your logo only" is
 * one of the things people are being asked to pay ₦4,000 a month for, and
 * until now `logoDataUri` was hardcoded null and every Pro invoice went out
 * carrying nothing.
 *
 * The image arrives as a WhatsApp message, which makes this the only place in
 * the product where a file from outside is stored and later rendered into a
 * document a third party opens. So it is treated as untrusted: the type is
 * decided by what the bytes actually are rather than what the sender claimed,
 * anything that is not a plain raster image is refused, and the size is capped
 * twice over.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { downloadMedia } from "../whatsapp/client.ts";
import { get as getFile, put } from "../storage/files.ts";

/** Comfortably big enough for a logo, small enough to inline in a render. */
const MAX_BYTES = 2 * 1024 * 1024;

export const logoKey = (userId: string): string => `logos/${userId}`;

/**
 * What the bytes really are.
 *
 * Read from the magic numbers, not the mime type Meta reports, because that
 * comes from the sending phone. An SVG is refused however it is labelled: it
 * is a document, it can carry script and external references, and it would be
 * inlined into a page a client opens.
 */
function sniff(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

export type SaveOutcome =
  | { ok: true }
  | { ok: false; why: "too_large" | "not_an_image" | "download_failed" };

/** Fetches the image the user sent and keeps it as their logo. */
export async function saveLogo(
  userId: string,
  mediaId: string,
  log: FastifyBaseLogger,
): Promise<SaveOutcome> {
  const got = await downloadMedia(mediaId, { maxBytes: MAX_BYTES });

  if (!got.ok) {
    const tooBig = /too large/.test(got.reason);
    if (!tooBig) log.error({ userId, reason: got.reason }, "could not download a logo");
    return { ok: false, why: tooBig ? "too_large" : "download_failed" };
  }

  const contentType = sniff(got.bytes);
  if (!contentType) {
    log.info({ userId, claimed: got.contentType }, "logo refused: not a raster image");
    return { ok: false, why: "not_an_image" };
  }

  const key = logoKey(userId);
  await put(key, got.bytes, contentType, userId);
  await db().query(`UPDATE users SET logo_url = $2 WHERE id = $1`, [userId, key]);

  log.info({ userId, bytes: got.bytes.length, contentType }, "logo saved");
  return { ok: true };
}

/** Forgets it, so the next invoice goes out without one. */
export async function clearLogo(userId: string): Promise<void> {
  await db().query(`UPDATE users SET logo_url = NULL WHERE id = $1`, [userId]);
}

/**
 * The logo as a data URI, for a renderer that must never fetch anything.
 *
 * Returns null for a Free user even when one is stored, so a lapsed
 * subscription stops putting it on documents the same way a Pro template does.
 * Keeping the file rather than deleting it means resubscribing brings it back.
 */
export async function logoDataUri(
  userId: string,
  plan: "free" | "pro",
  logoUrlColumn: string | null,
): Promise<string | null> {
  if (plan !== "pro" || !logoUrlColumn) return null;

  const file = await getFile(logoUrlColumn);
  if (!file) return null;

  return `data:${file.contentType};base64,${file.bytes.toString("base64")}`;
}
