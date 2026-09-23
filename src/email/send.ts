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
import { defaults, env } from "../config.ts";
import { formatNaira } from "../../core/totals.ts";
import { availableTo } from "../pdf/templates.ts";
import {
  button,
  codeBlock,
  detailCard,
  divider,
  layout,
  LOGO_CID,
  LOGO_DARK_CID,
  paragraph,
  steps,
  type InlineImage,
} from "./layout.ts";
import { esc } from "../documents/page.ts";
import { attachmentContent } from "./assets.ts";

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

  /**
   * Pictures shown in the body beyond the logo, which every message carries.
   * Each must be the same object passed to `layout`, so the ids agree.
   */
  images?: InlineImage[];
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
                  content: attachmentContent("logo.png"),
                  content_id: LOGO_CID,
                  content_type: "image/png",
                },
                {
                  filename: "balans-dark.png",
                  content: attachmentContent("logo-dark.png"),
                  content_id: LOGO_DARK_CID,
                  content_type: "image/png",
                },
                ...(email.images ?? []).map((i) => ({
                  filename: i.file,
                  content: attachmentContent(i.file),
                  content_id: i.cid,
                  content_type: "image/png",
                })),
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
      eyebrow: "Balans account",
      heading: "Your verification code",
      body: [
        paragraph(
          businessName
            ? // Their own words, escaped: `paragraph` takes HTML.
              `Here is the code to finish setting up ${esc(businessName)} on Balans.`
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

/** The picture at the top of the welcome. Drawn in assets/email/welcome-banner.html. */
const WELCOME_BANNER: InlineImage = {
  cid: "welcome-banner",
  file: "welcome-banner.png",
  alt: "Welcome. Let's get you paid.",
  // The column is 600 wide with 32px either side. The file is twice this.
  width: 536,
  height: 214,
};

/**
 * Sent once, when somebody finishes signing up.
 *
 * Signing up happens in a chat, so this is the first thing from Balans that
 * lands anywhere else — and the first thing they can find again next week
 * when they have forgotten what to type. So it does one job: shows the three
 * steps of getting paid, in the words the product actually uses, and points
 * back at the chat. No feature tour, no founder letter, no survey.
 *
 * Every claim in it is one the product keeps: the example is a line the
 * parser reads, the money settles to their account and not ours, and the
 * receipt is attached to the WhatsApp message that says a payment landed.
 */
export function welcomeEmail(opts: {
  businessName: string | null;
  email: string;
  /** Our WhatsApp number, digits only, for the button. Null leaves it out. */
  waNumber: string | null;
}): Omit<Email, "to"> {
  const business = opts.businessName?.trim() || null;
  const free = defaults.plans.free.documentsPerMonth;
  const chat = opts.waNumber ? `https://wa.me/${opts.waNumber}` : null;
  const example = "Invoice Tunde 150k for logo design, due Friday";

  return {
    subject: business ? `Welcome to Balans, ${business}` : "Welcome to Balans",
    // The closing line invites a reply, so it has to land somewhere read.
    replyTo: env.SUPPORT_EMAIL,
    images: [WELCOME_BANNER],

    text: [
      business ? `${business} is ready to get paid.` : "You are ready to get paid.",
      "",
      "Everything in Balans happens in the WhatsApp chat you signed up in. There is no app to install and nothing to log in to.",
      "",
      "1. Send the job and the amount",
      `   Type something like "${example}". You get back an invoice and a payment link to send your client.`,
      "",
      "2. Your client pays by bank transfer",
      "   The link gives them an account for that invoice alone. The money settles to your own bank account; Balans never holds it.",
      "",
      "3. You hear the moment it lands",
      "   We message you on WhatsApp as soon as a payment comes in, with the receipt attached.",
      "",
      `You are on the Free plan: ${free} documents a month.`,
      chat ? `Open the chat: ${chat}` : "",
      "",
      `Questions? Reply to this email, or write to ${env.SUPPORT_EMAIL}.`,
      "",
      "—",
      `Balans is a product of ${env.LEGAL_ENTITY_NAME}.`,
      "Payments processed by Monnify.",
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n"),

    html: layout({
      preheader: "Your first invoice takes one message. Here is how.",
      banner: WELCOME_BANNER,
      heading: business ? `${business} is ready to get paid` : "You are ready to get paid",
      body: [
        paragraph(
          "Everything in Balans happens in the WhatsApp chat you signed up in. There is no app to install and nothing to log in to.",
        ),
        steps([
          {
            title: "Send the job and the amount",
            text: `Type something like <em>${esc(example)}</em>. You get back an invoice and a payment link to send your client.`,
          },
          {
            title: "Your client pays by bank transfer",
            text: "The link gives them an account for that invoice alone. The money settles to your own bank account; Balans never holds it.",
          },
          {
            title: "You hear the moment it lands",
            text: "We message you on WhatsApp as soon as a payment comes in, with the receipt attached.",
          },
        ]),
        detailCard([
          ...(business ? [{ label: "Business", value: business }] : []),
          { label: "Plan", value: `Free, ${free} documents a month` },
          { label: "Account email", value: opts.email },
        ]),
        chat ? button("Open Balans in WhatsApp", chat) : "",
        paragraph(
          `Questions? Reply to this email, or write to <a href="mailto:${esc(env.SUPPORT_EMAIL)}" style="color:inherit;">${esc(env.SUPPORT_EMAIL)}</a>.`,
          true,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}

/** The picture at the top of the Pro email. Drawn in assets/email/pro-banner.html. */
const PRO_BANNER: InlineImage = {
  cid: "pro-banner",
  file: "pro-banner.png",
  alt: "You're on Pro.",
  width: 536,
  height: 214,
};

/**
 * Sent when a Pro payment lands.
 *
 * The first one is a welcome: the three things Pro changes that need the user
 * to do something — a logo, a design — or to know something has started on
 * its own, which is the reminders. The facts of the payment sit under them,
 * because this is also the only record of it they get outside the chat.
 *
 * Every later month is a receipt and nothing else. A welcome on the fourth
 * renewal reads like a system that does not know who it is talking to.
 *
 * Nothing here says Pro renews by itself, because it does not: the user is
 * reminded three days before and pays again.
 */
export function proEmail(opts: {
  businessName: string | null;
  /** Whether this is their first month of Pro. */
  first: boolean;
  amountKobo: number;
  until: Date;
  /** Our WhatsApp number, digits only, for the button. Null leaves it out. */
  waNumber: string | null;
}): Omit<Email, "to"> {
  const business = opts.businessName?.trim() || null;
  const pro = defaults.plans.pro;
  const until = opts.until.toLocaleDateString("en-GB", {
    timeZone: defaults.behaviour.timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const paid = formatNaira(opts.amountKobo);
  const designs = availableTo("pro").length;
  const chat = opts.waNumber ? `https://wa.me/${opts.waNumber}` : null;
  const fee = pro.feePercentBps === 0 ? "None" : `${pro.feePercentBps / 100}%`;

  const facts = [
    { label: "Plan", value: "Balans Pro" },
    { label: "Paid", value: paid },
    { label: "Active until", value: until },
    { label: "Balans fee on payments", value: fee },
  ];
  const renewal = `We will message you on WhatsApp three days before it ends. Reply settings in the chat to change or cancel it.`;
  const footer = [
    "",
    "—",
    `Balans is a product of ${env.LEGAL_ENTITY_NAME}.`,
    "Payments processed by Monnify.",
  ];

  if (!opts.first) {
    return {
      subject: `Balans Pro renewed until ${until}`,
      replyTo: env.SUPPORT_EMAIL,
      text: [
        `Your payment of ${paid} went through, and Pro is active until ${until}.`,
        "",
        ...facts.map((f) => `${f.label}: ${f.value}`),
        "",
        renewal,
        ...footer,
      ].join("\n"),
      html: layout({
        preheader: `${paid} received. Pro is active until ${until}.`,
        eyebrow: "Balans Pro",
        heading: `Pro renewed until ${until}`,
        body: [
          paragraph(`Your payment of <strong>${esc(paid)}</strong> went through. Thanks for staying on Pro.`),
          detailCard(facts),
          paragraph(renewal.replace("settings", "<strong>settings</strong>"), true),
        ].join("\n"),
      }),
    };
  }

  const firstSteps = [
    {
      title: "Put your logo on your invoices",
      text: "Send your logo to the chat as a picture. It goes on every invoice from the next one.",
    },
    {
      title: `Choose from all ${designs} designs`,
      text: "Reply <strong>/design</strong> in the chat to pick how your invoices look.",
    },
    {
      title: "Let the reminders do the chasing",
      text: "Clients who have not paid get a polite reminder on their own. You do not have to do anything.",
    },
  ];

  return {
    subject: "You're on Balans Pro",
    replyTo: env.SUPPORT_EMAIL,
    images: [PRO_BANNER],
    text: [
      business ? `${business} is on Balans Pro.` : "You are on Balans Pro.",
      "",
      `Your payment of ${paid} went through. From your next message: unlimited invoices${
        pro.feePercentBps === 0 ? ", and no Balans fee on what your clients pay you" : ""
      }.`,
      "",
      ...firstSteps.flatMap((s, i) => [`${i + 1}. ${s.title}`, `   ${s.text.replace(/<\/?strong>/g, "")}`, ""]),
      ...facts.map((f) => `${f.label}: ${f.value}`),
      "",
      renewal,
      chat ? `Open the chat: ${chat}` : "",
      ...footer,
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n"),
    html: layout({
      preheader: `${paid} received. Here is what Pro changes.`,
      banner: PRO_BANNER,
      heading: business ? `${business} is on Pro` : "Thanks for going Pro",
      body: [
        paragraph(
          `Your payment of <strong>${esc(paid)}</strong> went through. From your next message you have unlimited invoices${
            pro.feePercentBps === 0 ? ", and no Balans fee on what your clients pay you" : ""
          }.`,
        ),
        steps(firstSteps),
        detailCard(facts),
        chat ? button("Open Balans in WhatsApp", chat) : "",
        paragraph(renewal.replace("settings", "<strong>settings</strong>"), true),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}
