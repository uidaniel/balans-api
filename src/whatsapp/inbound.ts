/**
 * Turns Meta's webhook envelope into a flat inbound message.
 *
 * The envelope is deeply nested and every level is optional, because the same
 * shape carries messages, delivery receipts, account updates and errors. Doing
 * this once, here, keeps the optional-chaining out of the conversation code —
 * which should be reasoning about what someone asked for, not about whether
 * `entry[0].changes[0].value.messages` exists.
 */

export type InboundKind =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "interactive"
  /**
   * Somebody opened the chat for the first time and has not typed anything.
   *
   * Meta sends this once, only while `enable_welcome_message` is on, and only
   * before the first real message. It is the one chance to say what the
   * product is to somebody who has just been handed a number and is looking at
   * an empty screen.
   */
  | "welcome"
  | "other";

export type Inbound = {
  /** Meta's message id. Unique, and what makes redelivery a no-op. */
  waMessageId: string;
  /** Sender, digits only, no plus. */
  from: string;
  /** The business number it arrived on, so one service can host several. */
  phoneNumberId?: string;
  kind: InboundKind;
  /** Present for text and for interactive replies. */
  text?: string;
  /** Media id, to be fetched separately if we ever act on it. */
  mediaId?: string;
  /** The name on the sender's WhatsApp profile, if Meta included it. */
  profileName?: string;
  /** When Meta says it was sent, not when we read it. */
  sentAt: Date;
  /** The message this one replies to, if any. */
  repliedTo?: string;
};

export type StatusUpdate = {
  waMessageId: string;
  status: string;
  recipient?: string;
  at: Date;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Meta sends seconds since the epoch, as a string. */
function when(ts: unknown): Date {
  const n = Number(str(ts) ?? ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

export function parseInbound(payload: unknown): { messages: Inbound[]; statuses: StatusUpdate[] } {
  const messages: Inbound[] = [];
  const statuses: StatusUpdate[] = [];
  const root = obj(payload);
  if (!root) return { messages, statuses };

  for (const entryRaw of arr(root.entry)) {
    const entry = obj(entryRaw);
    for (const changeRaw of arr(entry?.changes)) {
      const value = obj(obj(changeRaw)?.value);
      if (!value) continue;

      const phoneNumberId = str(obj(value.metadata)?.phone_number_id);

      // Profile names arrive in a parallel `contacts` array keyed by wa_id, not
      // on the message itself.
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        const contact = obj(c);
        const waId = str(contact?.wa_id);
        const name = str(obj(contact?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }

      for (const m of arr(value.messages)) {
        const msg = obj(m);
        const id = str(msg?.id);
        const from = str(msg?.from);
        if (!id || !from || !msg) continue;

        const type = str(msg.type) ?? "other";
        const out: Inbound = {
          waMessageId: id,
          from,
          phoneNumberId,
          kind: kindOf(type),
          sentAt: when(msg.timestamp),
          profileName: names.get(from),
          repliedTo: str(obj(obj(msg.context)?.id ? msg.context : undefined)?.id),
        };

        if (type === "request_welcome") {
          // No words to act on: the greeting is the whole event.
          out.text = "";
        } else if (type === "text") {
          out.text = str(obj(msg.text)?.body);
        } else if (type === "interactive") {
          // A tapped button or list item. Its id is the intent; its title is
          // what the person saw, so either can be matched on.
          const interactive = obj(msg.interactive);
          const reply = obj(interactive?.button_reply) ?? obj(interactive?.list_reply);
          out.text = str(reply?.id) ?? str(reply?.title);
        } else if (type === "button") {
          out.text = str(obj(msg.button)?.text);
        } else if (type === "image" || type === "audio" || type === "document" || type === "video") {
          const media = obj(msg[type]);
          out.mediaId = str(media?.id);
          // A caption is often the actual instruction: a logo sent with
          // "use this as my logo", or a receipt photo with the amount.
          out.text = str(media?.caption);
        }

        messages.push(out);
      }

      for (const s of arr(value.statuses)) {
        const st = obj(s);
        const id = str(st?.id);
        const status = str(st?.status);
        if (!id || !status) continue;
        statuses.push({
          waMessageId: id,
          status,
          recipient: str(st?.recipient_id),
          at: when(st?.timestamp),
        });
      }
    }
  }

  return { messages, statuses };
}

function kindOf(type: string): InboundKind {
  switch (type) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "document":
      return "document";
    case "interactive":
    case "button":
      return "interactive";
    case "request_welcome":
      return "welcome";
    default:
      return "other";
  }
}
