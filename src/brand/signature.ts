/**
 * The user's signature, for the "Authorised signature" line (see
 * `signature` in pdf/kit.ts).
 *
 * Made on a page rather than sent as a photo. A photo of a signature on paper
 * arrives on a white or grey background, at an angle, in the wrong ink, and
 * would sit on the document as a rectangle. The page draws on a transparent
 * canvas — with a finger, or by typing a name in one of a few script faces —
 * and trims it to the ink, so what lands on the invoice is the stroke and
 * nothing else.
 *
 * Every plan. A logo is Pro because it is branding; a signature is the
 * sender's own mark on a document with their name on it.
 */

import { randomBytes } from "node:crypto";
import { db } from "../db/pool.ts";
import { get as getFile, put } from "../storage/files.ts";

/** A trimmed PNG of a signature is a few tens of kilobytes. This is generous. */
export const MAX_SIGNATURE_BYTES = 600 * 1024;

export const signatureKey = (userId: string): string => `signatures/${userId}`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The page's link token: reused while it is live, a day from each issue.
 *
 * The same rule as the summary link, for the same reason — two messages that
 * each carry a link must both keep working, so a live token is handed out
 * again rather than replaced.
 */
export async function issueSignatureToken(userId: string): Promise<string> {
  const { rows } = await db().query<{ signature_token: string }>(
    `UPDATE users
        SET signature_token = COALESCE(
              CASE WHEN signature_token_expires_at > now() THEN signature_token END,
              $2),
            signature_token_expires_at = now() + interval '1 day'
      WHERE id = $1
      RETURNING signature_token`,
    [userId, randomBytes(16).toString("hex")],
  );
  return rows[0]!.signature_token;
}

export type SignatureOwner = { id: string; businessName: string | null; phone: string; signatureUrl: string | null };

/** Whose page this is, while the link is live. */
export async function ownerOfSignatureToken(token: string): Promise<SignatureOwner | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const { rows } = await db().query<{
    id: string;
    business_name: string | null;
    phone: string;
    signature_url: string | null;
  }>(
    `SELECT id, business_name, wa_phone AS phone, signature_url FROM users
      WHERE signature_token = $1
        AND signature_token_expires_at > now()
        AND status = 'active'`,
    [token],
  );
  const r = rows[0];
  return r ? { id: r.id, businessName: r.business_name, phone: r.phone, signatureUrl: r.signature_url } : null;
}

export type SignatureSave = { ok: true } | { ok: false; why: "not_png" | "too_large" };

/** A PNG data URL from the page, checked and kept. */
export async function saveSignature(userId: string, dataUrl: string): Promise<SignatureSave> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, why: "not_png" };
  const bytes = Buffer.from(m[1]!, "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, why: "too_large" };
  if (bytes.length < 64 || !bytes.subarray(0, 8).equals(PNG)) return { ok: false, why: "not_png" };

  const key = signatureKey(userId);
  await put(key, bytes, "image/png", userId);
  await db().query(`UPDATE users SET signature_url = $2 WHERE id = $1`, [userId, key]);
  return { ok: true };
}

/** Takes it off, so the next document goes out without the line at all. */
export async function clearSignature(userId: string): Promise<void> {
  await db().query(`UPDATE users SET signature_url = NULL WHERE id = $1`, [userId]);
}

/** The signature as a data URI, for a renderer that must never fetch anything. */
export async function signatureDataUri(signatureUrlColumn: string | null): Promise<string | null> {
  if (!signatureUrlColumn) return null;
  const file = await getFile(signatureUrlColumn);
  return file ? `data:${file.contentType};base64,${file.bytes.toString("base64")}` : null;
}
