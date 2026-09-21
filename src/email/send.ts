/**
 * Transactional email.
 *
 * Behind an interface, for the same reason payments are: the provider is a
 * choice, not an assumption. Two implementations today —
 *
 *   resend   real sending, when RESEND_API_KEY is set
 *   log      writes the message to the server log instead
 *
 * The log transport is not a stub that pretends to succeed. It says clearly
 * that nothing was delivered, and it exists so onboarding can be walked
 * end-to-end before a sending domain is verified — which takes DNS changes and
 * a day of propagation, and should not block the rest of the build.
 *
 * PRD-GAP: F12 needs open and click tracking on invoice emails. Verification
 * codes deliberately carry neither: a tracking pixel in a security email is
 * both pointless and a privacy problem.
 */

import type { FastifyBaseLogger } from "fastify";
import { env } from "../config.ts";
import { codeBlock, divider, layout, MARK_CID, paragraph } from "./layout.ts";
import { markAttachment } from "./assets.ts";

export type Email = {
  to: string;
  subject: string;
  /**
   * Plain text, always. Not a fallback to be skipped: some clients show it,
   * some people prefer it, and a message with no text part scores worse with
   * spam filters than one carrying both.
   */
  text: string;
  html?: string;

  /**
   * Who it appears to be from (F21).
   *
   * Client-facing mail goes out as "Their Business via Balans": the client
   * hired them, not us, and an invoice from a company the client has never
   * heard of is an invoice that gets queried. The address stays ours, because
   * that is the domain with the SPF and DKIM records.
   */
  fromName?: string;

  /** Where a reply should land. The user, for anything about their invoice. */
  replyTo?: string;

  /** A PDF, for an invoice or a receipt. */
  attachments?: { filename: string; content: Buffer }[];
};

/**
 * The same address, under a different display name.
 *
 * Only the name changes: the address must stay on the domain that holds the
 * SPF and DKIM records, or the mail lands in spam.
 */
function withName(name: string): string {
  const address = from().match(/<([^>]+)>/)?.[1] ?? from();
  // Quotes and angle brackets in a display name break the header.
  const safe = name.replace(/["<>\r\n]/g, "").trim().slice(0, 60) || "Balans";
  return `${safe} <${address}>`;
}

export type SendResult =
  | { ok: true; id: string; delivered: boolean }
  | { ok: false; retryable: boolean; reason: string };

export type Transport = "resend" | "log";

export function transport(): Transport {
  return process.env.RESEND_API_KEY ? "resend" : "log";
}

function from(): string {
  // Must be a domain verified with the provider, or Resend refuses it.
  return process.env.EMAIL_FROM ?? "Balans <onboarding@resend.dev>";
}

export async function sendEmail(
  email: Email,
  log: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (transport() === "log") {
    // Deliberately loud, and deliberately honest about not having sent.
    log.warn(
      { to: email.to, subject: email.subject, body: email.text },
      "EMAIL NOT SENT — no RESEND_API_KEY; printing it instead",
    );
    return { ok: true, id: `log-${Date.now()}`, delivered: false };
  }

  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: email.fromName ? withName(email.fromName) : from(),
        to: [email.to],
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        text: email.text,
        ...(email.html
          ? {
              html: email.html,
              // Only attached when there is HTML to show it in, so a plain-text
              // message does not arrive carrying a mystery file.
              attachments: [
                {
                  filename: "balans.png",
                  content: markAttachment(),
                  content_id: MARK_CID,
                  content_type: "image/png",
                },
                ...(email.attachments ?? []).map((a) => ({
                  filename: a.filename,
                  content: a.content.toString("base64"),
                })),
              ],
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (res.ok && body.id) return { ok: true, id: body.id, delivered: true };

    // 429 and 5xx are worth another go; a rejected address or an unverified
    // sending domain will fail identically forever.
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, retryable, reason: body.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, retryable: true, reason: `network: ${(e as Error).message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Voice per the design system: lead with the fact, say what to do, and never
 * imply the recipient did something wrong if they did not ask for this.
 */
export function verificationEmail(code: string, businessName?: string): Omit<Email, "to"> {
  const who = businessName ? ` for ${businessName}` : "";

  return {
    // The code goes in the subject so it can be read off a lock-screen
    // notification without opening anything, which is what people actually do.
    subject: `${code} is your Balans code`,

    text: [
      `Your Balans verification code${who} is:`,
      "",
      `    ${code}`,
      "",
      "It lasts 15 minutes and can be used once.",
      "",
      "If you did not ask for this, you can ignore this email. Nothing has been",
      "changed on your account.",
      "",
      "—",
      `Balans is a product of ${env.LEGAL_ENTITY_NAME}.`,
      "Payments processed by Monnify.",
    ].join("\n"),

    html: layout({
      preheader: `${code} is your code. It lasts 15 minutes.`,
      heading: "Your verification code",
      body: [
        paragraph(
          businessName
            ? `Here is the code to finish setting up ${businessName} on Balans.`
            : "Here is the code to finish setting up your Balans account.",
        ),
        codeBlock(code),
        paragraph("It lasts 15 minutes and can be used once.", true),
        divider(),
        paragraph(
          "If you did not ask for this, you can ignore this email. Nothing has been changed on your account.",
          true,
        ),
      ].join("\n"),
    }),
  };
}
