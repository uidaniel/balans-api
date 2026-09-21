/**
 * WhatsApp Cloud API client — the outbound half (PRD F1).
 *
 * Every send is one POST to the Graph API. Two things make this less trivial
 * than it looks:
 *
 *   Meta rate-limits and occasionally 500s, and a dropped "you have been paid"
 *   is worse than a late one, so transient failures are retried with backoff.
 *
 *   Outside the 24-hour customer service window only approved templates may be
 *   sent. Sending free text there fails with a specific error, and the caller
 *   needs to know that is what happened rather than treating it as an outage.
 */

import { env, require_ } from "../config.ts";

export type SendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; retryable: boolean; code?: number; reason: string; outsideWindow?: boolean };

/** Meta error codes worth telling apart. */
const OUTSIDE_WINDOW = new Set([131047, 131051, 470]);
const RETRYABLE = new Set([130429, 131048, 133016, 1, 2, 4]);

type Transport = typeof fetch;

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${path}`;
}

/**
 * Phone numbers go to Meta as digits only, no plus.
 *
 * Nigerian numbers are commonly written 0801…, which is the same subscriber as
 * 234801…. Sending the leading zero silently delivers nowhere, so it is
 * normalised here rather than at each call site.
 */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("234")) return digits.length === 13 ? digits : null;
  if (digits.startsWith("0")) {
    const rest = digits.slice(1);
    return rest.length === 10 ? `234${rest}` : null;
  }
  // Already international for somewhere else, or a bare 10-digit local number.
  if (digits.length === 10) return `234${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

async function call(
  path: string,
  body: unknown,
  fetchImpl: Transport,
  attempt = 0,
): Promise<SendResult> {
  require_("WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN");

  let res: Response;
  try {
    res = await fetchImpl(graphUrl(path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // A timeout or socket error says nothing about whether Meta acted on it,
    // so it is retryable but never assumed delivered.
    return retry(path, body, fetchImpl, attempt, `network: ${(e as Error).message}`, undefined);
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* Meta occasionally returns an HTML error page; text is enough to log. */
  }

  if (res.ok) {
    const messages = (json.messages as { id?: string }[] | undefined) ?? [];
    const id = messages[0]?.id;
    return id
      ? { ok: true, waMessageId: id }
      : { ok: false, retryable: false, reason: "accepted but no message id returned" };
  }

  const err = (json.error ?? {}) as { code?: number; message?: string };
  const code = err.code;
  const reason = err.message ?? `HTTP ${res.status}`;

  if (code && OUTSIDE_WINDOW.has(code)) {
    return { ok: false, retryable: false, code, reason, outsideWindow: true };
  }
  if (res.status === 429 || res.status >= 500 || (code && RETRYABLE.has(code))) {
    return retry(path, body, fetchImpl, attempt, reason, code);
  }
  return { ok: false, retryable: false, code, reason };
}

const MAX_ATTEMPTS = 3;

async function retry(
  path: string,
  body: unknown,
  fetchImpl: Transport,
  attempt: number,
  reason: string,
  code: number | undefined,
): Promise<SendResult> {
  if (attempt + 1 >= MAX_ATTEMPTS) return { ok: false, retryable: true, code, reason };
  // 400ms, 1200ms. Short: a person is waiting on the other end of this.
  await new Promise((r) => setTimeout(r, 400 * 3 ** attempt));
  return call(path, body, fetchImpl, attempt + 1);
}

/** A plain text reply. Only valid inside the 24-hour window. */
export function sendText(
  to: string,
  body: string,
  opts: { previewUrl?: boolean; fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }
  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { preview_url: opts.previewUrl ?? false, body },
    },
    opts.fetchImpl ?? fetch,
  );
}

/**
 * Marks an inbound message read and, optionally, shows the typing bubble.
 *
 * One call does both: Meta carries the typing indicator on the same read
 * receipt. The bubble clears by itself after about 25 seconds, or the moment
 * the next message is sent — so it is only ever shown when there is genuinely
 * something being worked on, never as decoration.
 *
 * Cosmetic, and deliberately never retried: if it fails the person still gets
 * their answer, and a retry storm over a read receipt helps nobody.
 */
export async function markRead(
  waMessageId: string,
  opts: { typing?: boolean; fetchImpl?: Transport } = {},
): Promise<void> {
  try {
    await call(
      `${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
        ...(opts.typing ? { typing_indicator: { type: "text" } } : {}),
      },
      opts.fetchImpl ?? fetch,
      MAX_ATTEMPTS - 1,
    );
  } catch {
    /* Best effort. */
  }
}

/* -------------------------------------------------------------------------- */
/* Documents (PRD F20: "WhatsApp receives it as a document upload")            */
/* -------------------------------------------------------------------------- */

export type UploadResult = { ok: true; mediaId: string } | { ok: false; reason: string };

/**
 * Uploads bytes to Meta and returns the id to send them by.
 *
 * Two steps, not one: Meta will not take a document inline, and it will not
 * fetch one from a URL unless that URL is public. Ours is not — an invoice
 * link is a credential — so the bytes go up directly.
 *
 * Media ids expire after 30 days. Nothing here caches one: an invoice is sent
 * once, and re-sending re-uploads, which costs a second and removes a whole
 * class of "why is this document missing" problems.
 */
export async function uploadDocument(
  bytes: Buffer,
  filename: string,
  contentType = "application/pdf",
  fetchImpl: Transport = fetch,
): Promise<UploadResult> {
  require_("WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN");

  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", contentType);
  // A Blob rather than a stream: Meta wants a length, and these are small.
  form.set("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);

  let res: Response;
  try {
    res = await fetchImpl(graphUrl(`${env.WA_PHONE_NUMBER_ID}/media`), {
      method: "POST",
      headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      body: form,
      // Longer than a text send: this is an upload, not a request.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${(e as Error).message}` };
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) {
    return { ok: false, reason: body.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, mediaId: body.id };
}

/**
 * Sends an already-uploaded document, with a caption.
 *
 * The caption is the message: WhatsApp shows it under the file, so a separate
 * text would be a second bubble saying what the first one already says. One
 * message, one charge, per section 16's budget.
 */
export function sendDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption: string,
  opts: { fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }
  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "document",
      document: { id: mediaId, filename, caption },
    },
    opts.fetchImpl ?? fetch,
  );
}

/* -------------------------------------------------------------------------- */
/* Templates (PRD F16)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sends an approved template.
 *
 * The only thing that reaches a user outside the 24-hour window. Parameters
 * are positional and Meta matches them against what was approved, so a wrong
 * count is rejected outright rather than delivering something garbled.
 */
export function sendTemplate(
  to: string,
  template: string,
  params: string[],
  opts: { language?: string; fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }
  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "template",
      template: {
        name: template,
        language: { code: opts.language ?? "en" },
        components: params.length
          ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
          : [],
      },
    },
    opts.fetchImpl ?? fetch,
  );
}
