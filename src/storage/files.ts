/**
 * Where files live (PRD section 3).
 *
 * The whole point of this module is that nothing else knows the answer. Today
 * bytes go in Postgres; section 3 wants object storage with signed URLs, and
 * that is a change to this file and nothing else. Keys are already shaped the
 * way a bucket would want them.
 *
 * Nothing here is public. A file is reached through a route that has already
 * checked the document's token, which is the only credential a client has.
 */

import { db } from "../db/pool.ts";

export type StoredFile = { key: string; contentType: string; bytes: Buffer };

/**
 * Builds a storage key.
 *
 * Shaped like a path because it will be one: `documents/{id}/v3.pdf` is a
 * bucket key today and a bucket key tomorrow.
 */
export const documentKey = (documentId: string, version: number): string =>
  `documents/${documentId}/v${version}.pdf`;

export const receiptKey = (paymentId: string): string => `receipts/${paymentId}.pdf`;

/**
 * A card drawn for one person, parked where Meta can come and fetch it.
 *
 * Every other picture in this product is uploaded to Meta and referred to by
 * id, because an upload has no address and these carry somebody's figures.
 * One message type leaves no choice: a `cta_url` header — the message with
 * the link button on it — takes an image only as a URL, and refuses an id
 * along with the whole message.
 *
 * So the card gets an address, and the address is built to be worth as little
 * as possible to anyone who finds it: 32 random bytes, served with no-store
 * and noindex, and dead within the hour. Meta fetches it within seconds of
 * the send. The same message already carries a link to the summary page,
 * which shows strictly more than the card does and lives a day.
 */
export const cardKey = (token: string): string => `cards/${token}.png`;

/** How long a card's address is worth anything. Meta fetches it at once. */
const CARD_MINUTES = 60;

export async function putCard(token: string, png: Buffer, userId: string): Promise<void> {
  await put(cardKey(token), png, "image/png", userId);

  /*
   * Sweep on the way past, rather than in a job.
   *
   * These are 40KB each and one is made every time somebody runs /owed or
   * /summary, so without this the table grows for ever with pictures nobody
   * can fetch any more. Doing it here means the cleanup cannot be forgotten
   * and cannot fail separately from the thing it cleans up after.
   */
  await db().query(
    `DELETE FROM stored_files
      WHERE key LIKE 'cards/%' AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(CARD_MINUTES)],
  );
}

/**
 * A card, if the address is still worth something.
 *
 * Expiry is enforced in the query rather than by the sweep above, so a row
 * the sweep has not reached yet is still refused. An expired card is a 404
 * and not an "expired" page, for the same reason the summary link is.
 */
export async function getCard(token: string): Promise<Buffer | null> {
  const { rows } = await db().query<{ bytes: Buffer }>(
    `SELECT bytes FROM stored_files
      WHERE key = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [cardKey(token), String(CARD_MINUTES)],
  );
  return rows[0]?.bytes ?? null;
}

export async function put(
  key: string,
  bytes: Buffer,
  contentType: string,
  userId: string | null,
): Promise<string> {
  await db().query(
    `INSERT INTO stored_files (key, content_type, bytes, byte_size, user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE
       SET bytes = EXCLUDED.bytes,
           byte_size = EXCLUDED.byte_size,
           content_type = EXCLUDED.content_type`,
    [key, contentType, bytes, bytes.length, userId],
  );
  return key;
}

export async function get(key: string): Promise<StoredFile | null> {
  const { rows } = await db().query<{ key: string; content_type: string; bytes: Buffer }>(
    `SELECT key, content_type, bytes FROM stored_files WHERE key = $1`,
    [key],
  );
  const r = rows[0];
  return r ? { key: r.key, contentType: r.content_type, bytes: r.bytes } : null;
}

export async function exists(key: string): Promise<boolean> {
  const { rows } = await db().query(`SELECT 1 FROM stored_files WHERE key = $1`, [key]);
  return rows.length > 0;
}

/**
 * A name a person can find again in their downloads folder.
 *
 * F20: "Invoice-14-Zenith-Homes.pdf. Strip characters unsafe for file names."
 * Unsafe here means anything Windows, macOS or a Content-Disposition header
 * would argue with, which is a longer list than it first appears: quotes and
 * semicolons break the header itself.
 */
export function fileName(kind: string, number: number | null, client: string): string {
  const safe = client
    .normalize("NFKD")
    // Anything outside plain ASCII letters, digits and spaces becomes a gap.
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join("-");

  const parts = [kind, number === null ? null : String(number), safe || "Client"].filter(Boolean);
  return `${parts.join("-")}.pdf`;
}
