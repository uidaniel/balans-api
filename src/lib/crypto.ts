/**
 * Encryption at rest and signature checking (PRD section 11).
 *
 * Account numbers and TOTP secrets are encrypted; webhook signatures are
 * compared in constant time. Both are small, and both are the kind of thing
 * that is silently wrong until it matters, so each has a test beside it.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env, require_ } from "../config.ts";

const ALG = "aes-256-gcm";
const IV_BYTES = 12; // GCM's nominal nonce length.
const TAG_BYTES = 16;

function key(): Buffer {
  require_("ENCRYPTION_KEY");
  const k = Buffer.from(env.ENCRYPTION_KEY!, "base64");
  if (k.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes base64, got ${k.length}`);
  }
  return k;
}

/**
 * Encrypts to `iv | ciphertext | tag`.
 *
 * A fresh random IV per call, so encrypting the same account number twice
 * produces different bytes and the column cannot be used as an oracle.
 */
export function encrypt(plain: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

export function decrypt(blob: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES + 1) throw new Error("ciphertext too short");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const body = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const d = createDecipheriv(ALG, key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/** Constant-time compare that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a leak,
  // so compare each against a same-length digest instead.
  const ha = createHmac("sha256", "cmp").update(ab).digest();
  const hb = createHmac("sha256", "cmp").update(bb).digest();
  return timingSafeEqual(ha, hb) && ab.length === bb.length;
}

/**
 * Verifies Meta's `X-Hub-Signature-256` over the raw request body.
 *
 * It must be the raw bytes, not a re-serialised object: JSON.stringify of a
 * parsed body will not reproduce the exact payload Meta hashed, and the check
 * would fail for reasons that look like a configuration problem.
 */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(header.slice("sha256=".length), expected);
}

/**
 * Verifies Monnify's `monnify-signature` header: SHA-512 HMAC of the raw body
 * keyed with the client secret.
 *
 * PRD-GAP: confirm the header name and digest against Monnify's current docs in
 * sandbox before going live. Section 11 says reject anything unsigned, so a
 * mistake here fails closed rather than open.
 */
export function verifyMonnifySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac("sha512", secret).update(raw).digest("hex");
  return safeEqual(header, expected);
}

/** URL-safe token for public document links (section 11: CSPRNG, unguessable). */
export function publicToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
