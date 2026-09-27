/**
 * The "we're live" message: everything the waitlist will see, in one place.
 *
 * The WhatsApp template submitted to Meta, the email, the sender and the
 * admin's preview all read from here — so what staff preview is what goes
 * out, and changing the copy is one edit. The admin cannot import this file
 * (it is another application), so the service writes it to `config` at boot
 * as `broadcast.launch_live`, and the preview renders that.
 *
 * Once Meta approves the template its words are fixed. Changing `whatsapp`
 * below after approval needs a new template name, or the preview and the
 * message people receive will disagree.
 */

import { env } from "../config.ts";

const site = env.SITE_URL.replace(/\/$/, "");

export const LAUNCH = {
  /** The template's name at Meta, and the campaign's id in `broadcasts`. */
  campaign: "launch_live",

  /** 1080×1350, from the poster; public so WhatsApp and email can fetch it. */
  image: `${site}/broadcast/launch-2cdf09d77fed.jpg`,

  whatsapp: {
    body: [
      "Balans is live 🎉",
      "",
      "You joined the waitlist, and we are open. Send one line like *invoice Tunde 50k for logo design* and get back a branded invoice with a link that pays straight into your bank.",
      "",
      "Tap below to set up. It takes about 3 minutes.",
    ].join("\n"),
    footer: "You are getting this because you joined our waitlist",
    button: {
      text: "Set me up",
      // The end of the address is filled per send, so the button can be
      // pointed somewhere else later without a new template.
      url: `${site}/{{1}}`,
      example: `${site}/start`,
    },
    /** What fills `{{1}}`: the chat with Balans, via the site. */
    suffix: "start?ref=wa-launch",
  },

  email: {
    subject: "Balans is live",
    preheader: "You joined the waitlist. We are open — set up in three minutes.",
    heading: "Balans is live.",
    paragraphs: [
      "You joined the waitlist, and we are open.",
      "Send one line on WhatsApp — like “invoice Tunde 50k for logo design” — and get back a branded invoice with a link that pays straight into your own bank account.",
      "Setting up takes about three minutes, all inside the chat.",
    ],
    button: "Start on WhatsApp",
    link: `${site}/start?ref=email-launch`,
    footer: "You are getting this because you joined the Balans waitlist. Reply to this email and we will take you off.",
  },
} as const;

/** The email, as text and HTML. The poster is fetched by address, not attached. */
export function launchEmail(): { subject: string; text: string; html: string } {
  const e = LAUNCH.email;
  const text = [e.heading, "", ...e.paragraphs.flatMap((p) => [p, ""]), `${e.button}: ${e.link}`, "", e.footer].join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(e.subject)}</title></head>
<body style="margin:0;background:#f6f1e7;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#10231c">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(e.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf8;border-radius:24px;overflow:hidden">
<tr><td><img src="${LAUNCH.image}" width="560" alt="Balans is live" style="display:block;width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:30px 32px 8px">
<h1 style="margin:0 0 14px;font-size:26px;line-height:1.15;letter-spacing:-0.02em">${esc(e.heading)}</h1>
${e.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:rgba(16,35,28,.78)">${esc(p)}</p>`).join("\n")}
</td></tr>
<tr><td style="padding:10px 32px 34px">
<a href="${e.link}" style="display:inline-block;background:#f5b82e;color:#10231c;font-weight:700;font-size:16px;text-decoration:none;padding:15px 28px;border-radius:999px">${esc(e.button)}</a>
</td></tr>
</table>
<p style="max-width:520px;margin:18px auto 0;font-size:12px;line-height:1.5;color:rgba(16,35,28,.5)">${esc(e.footer)}</p>
</td></tr></table></body></html>`;

  return { subject: e.subject, text, html };
}
