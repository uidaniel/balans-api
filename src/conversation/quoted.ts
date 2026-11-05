/**
 * Which invoice a quoted message was about (5 November 2026).
 *
 * People reply to one of our cards with "did you send it?" or "reverse it",
 * which names nothing, and were answered "Which one?" while pointing at it.
 * WhatsApp says which message they replied to; ours are in `messages`. The
 * document behind it is the one made just before it went: a draft card is
 * sent seconds after its draft is saved, and sending it keeps the same row.
 *
 * `known` is false when the quoted message is not one of ours on file, and
 * then nothing changes. With `known` and no document, nothing was made just
 * before it, so nothing was sent from it either: a draft that was dropped
 * leaves no row, and only "Send it" sends.
 */

import { db } from "../db/pool.ts";

export type Quoted = {
  known: boolean;
  doc: { id: string; number: number | null; status: string; type: string } | null;
};

export async function quotedDocument(userId: string, waMessageId: string): Promise<Quoted> {
  const mine = await db().query<{ at: Date }>(
    `SELECT created_at AS at FROM messages WHERE wa_message_id = $1 AND user_id = $2 AND direction = 'out' LIMIT 1`,
    [waMessageId, userId],
  );
  const at = mine.rows[0]?.at;
  if (!at) return { known: false, doc: null };
  const { rows } = await db().query<{ id: string; number: number | null; status: string; type: string }>(
    `SELECT id, number, status, type FROM documents
      WHERE user_id = $1 AND type <> 'sample'
        AND created_at BETWEEN $2::timestamptz - interval '3 minutes' AND $2::timestamptz + interval '5 seconds'
      ORDER BY created_at DESC LIMIT 1`,
    [userId, at],
  );
  return { known: true, doc: rows[0] ?? null };
}

/** The intents that are about one document and may take it from a quote. */
export const QUOTABLE = new Set(["status", "cancel_document", "resend_document", "stop_reminders"]);
