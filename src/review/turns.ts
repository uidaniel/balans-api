/**
 * What was said, both ways, for the daily review (5 November 2026).
 *
 * Masked before it is written: a phone or account number keeps its last
 * three digits, an email its domain, and a link is a link. The review needs
 * what somebody meant, not who they or their client are. Never in the way:
 * a failure here changes nothing about the reply.
 */

import { db } from "../db/pool.ts";

const MAX = 1200;

/** Phone and account numbers, emails and links, made safe to keep and to send for review. */
export function maskText(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "[email]@$1")
    .replace(/\+?\d[\d\s-]{6,}\d/g, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 7 ? `[number …${digits.slice(-3)}]` : m;
    })
    .slice(0, MAX);
}

export async function noteInbound(
  userId: string,
  m: { kind: string; text?: string | null; quoted?: boolean },
): Promise<void> {
  try {
    await db().query(`INSERT INTO bot_turns (user_id, kind, inbound, quoted) VALUES ($1, $2, $3, $4)`, [
      userId,
      m.kind,
      m.text ? maskText(m.text) : null,
      Boolean(m.quoted),
    ]);
  } catch {
    // The review misses one; the conversation does not.
  }
}

/** Added to the latest turn from the last five minutes, which is the one this answers. */
export async function noteReply(userId: string, text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await db().query(
      `UPDATE bot_turns SET reply = left(COALESCE(reply || E'\\n\\n', '') || $2, ${MAX * 2})
        WHERE id = (SELECT id FROM bot_turns WHERE user_id = $1 AND at > now() - interval '5 minutes'
                     ORDER BY at DESC LIMIT 1)`,
      [userId, maskText(text)],
    );
  } catch {
    // As above.
  }
}
