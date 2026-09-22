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


export type DownloadResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; reason: string };

/**
 * Fetches media a user sent, by the id Meta gave us on the webhook.
 *
 * Two calls, because Meta will not hand over bytes directly: the first asks
 * where the file lives, the second collects it. Both need the token, and the
 * URL from the first is short-lived, so there is no point keeping it.
 *
 * Capped at `maxBytes`. The cap is the point of the function as much as the
 * download is: this is the one place a stranger's phone decides how many bytes
 * we allocate, and a 40MB video sent by accident should be refused rather than
 * read into memory to find out.
 */
export async function downloadMedia(
  mediaId: string,
  opts: { maxBytes?: number; fetchImpl?: Transport } = {},
): Promise<DownloadResult> {
  require_("WA_ACCESS_TOKEN");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const auth = { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` };

  let where: Response;
  try {
    where = await fetchImpl(graphUrl(mediaId), {
      method: "GET",
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${(e as Error).message}` };
  }

  const meta = (await where.json().catch(() => ({}))) as {
    url?: string;
    mime_type?: string;
    file_size?: number;
    error?: { message?: string };
  };

  if (!where.ok || !meta.url) {
    return { ok: false, reason: meta.error?.message ?? `HTTP ${where.status}` };
  }

  // Refused on the size Meta reports, before a byte is transferred.
  if (typeof meta.file_size === "number" && meta.file_size > maxBytes) {
    return { ok: false, reason: `too large: ${meta.file_size} bytes` };
  }

  let file: Response;
  try {
    file = await fetchImpl(meta.url, {
      method: "GET",
      headers: auth,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${(e as Error).message}` };
  }

  if (!file.ok) return { ok: false, reason: `HTTP ${file.status}` };

  const bytes = Buffer.from(await file.arrayBuffer());
  // Checked again on what actually arrived: the reported size is their claim,
  // this is the fact.
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `too large: ${bytes.length} bytes` };
  }

  return {
    ok: true,
    bytes,
    contentType: meta.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * Sends an already-uploaded document, with a caption.
 *
 * The caption is the message: WhatsApp shows it under the file, so a separate
 * text would be a second bubble saying what the first one already says. One
 * message, one charge, per section 16's budget.
 */
/**
 * A picture with words under it.
 *
 * By URL, which Meta fetches: an uploaded media id expires after thirty days
 * and these are the same few files on every send. The caption is the message —
 * with images turned off, or slow to load, it is all somebody sees, so it has
 * to stand on its own.
 */
export function sendImage(
  to: string,
  link: string,
  caption: string,
  opts: { fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }
  if (!/^https?:\/\//i.test(link)) {
    return Promise.resolve({ ok: false, retryable: false, reason: `image needs an absolute URL: ${link}` });
  }

  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "image",
      image: { link, caption: caption.slice(0, 1024) },
    },
    opts.fetchImpl ?? fetch,
  );
}

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

/* -------------------------------------------------------------------------- */
/* Interactive lists                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A message with one button that opens a link.
 *
 * The same words could carry a bare URL, and a bare URL in WhatsApp is a grey
 * line of text somebody has to decide to trust. A button says what happens
 * when you press it, and it opens in the in-app browser rather than throwing
 * the user out of the chat.
 *
 * Costs exactly what a text message costs, so it replaces one rather than
 * following it.
 */
export function sendCta(
  to: string,
  content: { body: string; label: string; url: string; header?: string; footer?: string },
  opts: { fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }

  // Meta requires an absolute http(s) URL and refuses the whole message
  // otherwise, which would swallow the words as well as the button.
  if (!/^https?:\/\//i.test(content.url)) {
    return Promise.resolve({ ok: false, retryable: false, reason: `not a link: ${content.url}` });
  }

  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: {
        type: "cta_url",
        ...(content.header ? { header: { type: "text", text: content.header.slice(0, 60) } } : {}),
        body: { text: content.body.slice(0, 1024) },
        ...(content.footer ? { footer: { text: content.footer.slice(0, 60) } } : {}),
        action: {
          name: "cta_url",
          parameters: { display_text: content.label.slice(0, 20), url: content.url },
        },
      },
    },
    opts.fetchImpl ?? fetch,
  );
}

/**
 * A form, opened from the chat and filled in on one screen.
 *
 * Worth a message when several known facts have to be handed over at once —
 * onboarding asks for four and takes six messages to do it. Not worth one for
 * a decision, which is what buttons are for, and actively wrong for the thing
 * somebody came here to say in their own words.
 *
 * `navigate` means the form runs on its own and hands everything back when it
 * closes. `data_exchange` would let it call us between screens, which needs a
 * published key and a decrypting endpoint; nothing here needs that yet.
 *
 * `token` comes back untouched in the reply, so it is how a completed form is
 * tied to the conversation that sent it.
 */
export function sendFlow(
  to: string,
  content: {
    body: string;
    /** On the button that opens the form. Meta advises 30 characters. */
    cta: string;
    flowId: string;
    token: string;
    /** The screen to open on. */
    screen: string;
    /** Values the first screen starts with, for an edit form. */
    data?: Record<string, string | number | boolean>;
    header?: string;
    /**
     * A picture above the message, by URL.
     *
     * Meta fetches it itself, which is why this is a link rather than an
     * uploaded media id: an id expires after thirty days and the failure
     * arrives a month after anybody last looked at this. The URL is served by
     * this same API from a file in the repository.
     *
     * Takes precedence over `header`. A header is one thing or the other.
     */
    headerImage?: string;
    footer?: string;
    /** Draft flows can be opened by the developer before publishing. */
    draft?: boolean;
  },
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
      type: "interactive",
      interactive: {
        type: "flow",
        ...(content.headerImage
          ? { header: { type: "image", image: { link: content.headerImage } } }
          : content.header
            ? { header: { type: "text", text: content.header.slice(0, 60) } }
            : {}),
        body: { text: content.body.slice(0, 1024) },
        ...(content.footer ? { footer: { text: content.footer.slice(0, 60) } } : {}),
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: content.token,
            flow_id: content.flowId,
            flow_cta: content.cta.slice(0, 30),
            flow_action: "navigate",
            mode: content.draft ? "draft" : "published",
            flow_action_payload: {
              screen: content.screen,
              ...(content.data && Object.keys(content.data).length ? { data: content.data } : {}),
            },
          },
        },
      },
    },
    opts.fetchImpl ?? fetch,
  );
}

export type ReplyButton = {
  /**
   * Comes back as the message text when tapped, so it is written as something
   * the parser already understands — "yes", "I agree", "resend". At most 256
   * characters, though nothing here is near that.
   */
  id: string;
  /** At most 20 characters. Meta rejects the whole message for a longer one. */
  title: string;
};

/**
 * Up to three tappable replies under a message.
 *
 * The difference between this and "Reply *yes* to send it" is the difference
 * between one tap and: read the instruction, remember the word, open the
 * keyboard, spell it, send. Every one of those steps is somewhere a person
 * stops, and the last one is where they type "yeah" and get asked again.
 *
 * Three is Meta's limit. Anything with more answers than that wants `sendList`
 * instead, which holds ten.
 *
 * Costs exactly what a text message costs, so it replaces one rather than
 * following it.
 */
export function sendButtons(
  to: string,
  content: {
    body: string;
    buttons: ReplyButton[];
    header?: string;
    /**
     * A picture above the message, by URL.
     *
     * Reply buttons take one; a list does not. Probed against the live API —
     * an image header on `type: "list"` comes back 400 "Parameter value is
     * not valid", and on `type: "button"` it is accepted.
     *
     * Takes precedence over `header`. A header is one thing or the other.
     */
    headerImage?: string;
    footer?: string;
  },
  opts: { fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }

  // Caught here rather than discovered in production: Meta rejects the whole
  // message for one bad button, which would swallow the words as well.
  if (content.buttons.length < 1 || content.buttons.length > 3) {
    return Promise.resolve({
      ok: false,
      retryable: false,
      reason: `a message may carry one to three buttons, not ${content.buttons.length}`,
    });
  }

  // Duplicate ids make the reply ambiguous, and Meta does not check.
  const ids = new Set(content.buttons.map((b) => b.id));
  if (ids.size !== content.buttons.length) {
    return Promise.resolve({ ok: false, retryable: false, reason: "button ids must differ" });
  }

  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        ...(content.headerImage
          ? { header: { type: "image", image: { link: content.headerImage } } }
          : content.header
            ? { header: { type: "text", text: content.header.slice(0, 60) } }
            : {}),
        body: { text: content.body.slice(0, 1024) },
        ...(content.footer ? { footer: { text: content.footer.slice(0, 60) } } : {}),
        action: {
          buttons: content.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
          })),
        },
      },
    },
    opts.fetchImpl ?? fetch,
  );
}

export type ListRow = {
  /** Comes back as the message text when tapped, so it is read like a command. */
  id: string;
  /** At most 24 characters. Longer is silently rejected by Meta. */
  title: string;
  /** At most 72. */
  description?: string;
};

export type ListSection = { title?: string; rows: ListRow[] };

/**
 * A menu the user taps instead of typing.
 *
 * Worth the extra shape for anything with a fixed set of answers. A numbered
 * text list asks somebody to read, remember a number, switch to the keyboard
 * and type it; this is one tap, and a tap cannot be mistyped.
 *
 * The reply arrives as an ordinary inbound message carrying the row's `id`,
 * which is why the ids here are written as things the parser already
 * understands.
 */
export function sendList(
  to: string,
  content: {
    body: string;
    button: string;
    sections: ListSection[];
    header?: string;
    footer?: string;
  },
  opts: { fetchImpl?: Transport } = {},
): Promise<SendResult> {
  const phone = normalisePhone(to);
  if (!phone) {
    return Promise.resolve({ ok: false, retryable: false, reason: `unusable phone number: ${to}` });
  }

  // Meta rejects the whole message for a single over-long field, so the limits
  // are enforced here rather than discovered in production.
  const rows = content.sections.flatMap((s) => s.rows);
  if (rows.length > 10) {
    return Promise.resolve({ ok: false, retryable: false, reason: "a list may hold at most 10 rows" });
  }

  return call(
    `${env.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: {
        type: "list",
        ...(content.header ? { header: { type: "text", text: content.header.slice(0, 60) } } : {}),
        body: { text: content.body.slice(0, 1024) },
        ...(content.footer ? { footer: { text: content.footer.slice(0, 60) } } : {}),
        action: {
          button: content.button.slice(0, 20),
          sections: content.sections.map((s) => ({
            ...(s.title ? { title: s.title.slice(0, 24) } : {}),
            rows: s.rows.map((r) => ({
              id: r.id.slice(0, 200),
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    },
    opts.fetchImpl ?? fetch,
  );
}
