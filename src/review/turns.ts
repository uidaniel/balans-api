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

/**
 * What we sent, in words, from the request body itself (9 November 2026).
 * Recorded where every message leaves (whatsapp/client.ts `call`), so a card,
 * a form, a PDF or a list counts as an answer as much as a line of text does:
 * the first review emails showed those as "(nothing)".
 */
export function describeSent(body: unknown): string | null {
  const m = body as Record<string, any>;
  if (!m || typeof m !== "object") return null;
  switch (m.type) {
    case "text":
      return m.text?.body ?? null;
    case "image":
      return `[picture]${m.image?.caption ? ` ${m.image.caption}` : ""}`;
    case "document":
      return `[PDF: ${m.document?.filename ?? "file"}]${m.document?.caption ? ` ${m.document.caption}` : ""}`;
    case "template":
      return `[template: ${m.template?.name ?? "?"}]`;
    case "interactive": {
      const i = m.interactive ?? {};
      const text = i.body?.text ?? "";
      const extra =
        i.type === "button"
          ? `[buttons: ${(i.action?.buttons ?? []).map((x: any) => x.reply?.title).filter(Boolean).join(" | ")}]`
          : i.type === "list"
            ? `[list: ${(i.action?.sections ?? []).flatMap((sec: any) => sec.rows ?? []).map((r: any) => r.title).join(" | ")}]`
            : i.type === "flow"
              ? `[form: ${i.action?.parameters?.flow_cta ?? "open"}]`
              : i.type === "cta_url"
                ? `[link button: ${i.action?.parameters?.display_text ?? ""}]`
                : `[${i.type ?? "interactive"}]`;
      return [text, extra].filter(Boolean).join("\n");
    }
    default:
      return null;
  }
}

/** Added to the latest turn of whoever has this WhatsApp number, from the last five minutes. */
export async function noteSentTo(phone: string, body: unknown): Promise<void> {
  try {
    const text = describeSent(body);
    if (!text?.trim()) return;
    await db().query(
      `UPDATE bot_turns SET reply = left(COALESCE(reply || E'\\n\\n', '') || $2, ${MAX * 2})
        WHERE id = (SELECT t.id FROM bot_turns t JOIN users u ON u.id = t.user_id
                     WHERE u.wa_phone = $1 AND t.at > now() - interval '5 minutes'
                     ORDER BY t.at DESC LIMIT 1)`,
      [phone, maskText(text)],
    );
  } catch {
    // The review misses one; the message still went.
  }
}
