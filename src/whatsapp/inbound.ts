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
  /**
   * A submitted Flow form.
   *
   * Every field the form collected, as strings — Meta sends `response_json`
   * and everything inside it is a string, including numbers. `flow_token` is
   * the value we sent the form with, which is how a submission is tied back
   * to the conversation that asked for it.
   */
  flow?: { token: string; fields: Record<string, string> };

  /**
   * A message we are handing back to ourselves, not one Meta delivered.
   *
   * There is one: the sentence somebody opened with before they had an
   * account, replayed the moment setup finishes so it produces the draft
   * they asked for. It is the same text through the same pipeline, which is
   * the point — a second path that builds drafts a slightly different way is
   * a second path that can be wrong.
   *
   * What it changes: nothing is recorded as inbound, because nothing
   * arrived, and no read receipt is sent, because there is no message on
   * Meta's side to mark.
   */
  replay?: true;
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

          /*
           * A submitted Flow form.
           *
           * `response_json` is a JSON string inside the JSON, and it is
           * whatever the form's `complete` payload named — so it is read
           * defensively. A form that returns something unexpected must not
           * take the whole webhook down with it: the worst case here is an
           * interactive message with no words, which the handler already
           * knows how to answer.
           */
          const flow = obj(interactive?.nfm_reply);
          const raw = str(flow?.response_json);
          if (raw) {
            try {
              const parsed: unknown = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                const all = parsed as Record<string, unknown>;
                const fields: Record<string, string> = {};
                for (const [k, v] of Object.entries(all)) {
                  if (k === "flow_token") continue;
                  if (typeof v === "string") fields[k] = v;
                  else if (typeof v === "number" || typeof v === "boolean") fields[k] = String(v);
                }
                out.flow = { token: str(all.flow_token) ?? "", fields };
                // The form is the message. Without this the handler sees an
                // interactive message with no text and says it cannot read it.
                out.text = out.text ?? "";
              }
            } catch {
              // Not our JSON. Falls through as an ordinary interactive reply.
            }
          }
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
