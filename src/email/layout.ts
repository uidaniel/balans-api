/**
 * The shell every Balans email is built in.
 *
 * Email is not the web. Gmail strips much of a `<style>` block, Outlook renders
 * through Word, and neither supports flexbox or grid. So this is tables and
 * inline styles — not because it is nice, but because it is the only thing
 * that arrives looking the same everywhere.
 *
 * The design is a single card: the logo, a heading, a few lines of prose, the
 * facts in a quiet panel, one button, and the small print under a hairline at
 * the foot of the same card. No coloured header bar, no second column, no
 * row of social icons — nothing that makes a message look like it came off a
 * marketing template rather than from the product the reader uses.
 *
 * Images travel with the message and are referenced by content id rather than
 * fetched from a URL. Gmail and Outlook block remote images by default, so a
 * hosted logo arrives as an empty box for most people on first open; an
 * embedded one always renders, and does not depend on the site being up.
 *
 * The brand faces are asked for too, from our own host. Apple Mail and iOS
 * Mail load them; Gmail does not, and falls back to the system stack below —
 * which is why nothing here depends on the face being the brand's.
 *
 * PRD section 12 requires two lines on every email, and they are in the footer
 * where they cannot be forgotten.
 */

import { env } from "../config.ts";

/** brand/BRAND.md. Hex, because email has no custom properties. */
const C = {
  ink: "#10231C",
  marigold: "#F5B82E",
  cream: "#F6F1E7",
  white: "#FFFFFF",
  /** The panel the facts sit in: cream, lifted most of the way to white. */
  panel: "#FAF7F0",
  /** Body text that is not the heading. A solid value: opacity is unreliable. */
  body: "#3C4B45",
  /** Labels, small print. */
  muted: "#6B7872",
  /** The hairline everything is separated by. */
  line: "#ECE5D6",
};

const SANS =
  "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const DISPLAY = `'Geist', ${SANS}`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The content id the logo is attached under.
 *
 * Exported so the sender can attach the file with a matching id: the two must
 * agree or the image renders as a broken box.
 */
export const LOGO_CID = "balans-logo";

/** The logo's size in the message. The file is three times this. */
const LOGO = { width: 94, height: 28 };

/** An image attached to the message and shown inline. */
export type InlineImage = {
  cid: string;
  /** A file in assets/email. */
  file: string;
  alt: string;
  width: number;
  height: number;
};

export type LayoutOptions = {
  /** The line shown in the inbox list, after the subject. */
  preheader: string;
  heading: string;
  /** A short line over the heading: who or what this is about. Optional. */
  eyebrow?: string;
  /** A picture under the logo. The sender must attach the same file. */
  banner?: InlineImage;
  /** Already-escaped HTML for the body. */
  body: string;
};

/** Rules for the clients that read a `<style>` block. Everything else is inline. */
const HEAD_CSS = `
@font-face{font-family:'Instrument Sans';font-weight:400;src:url('${env.PUBLIC_BASE_URL}/designs/fonts/InstrumentSans-Regular.ttf') format('truetype')}
@font-face{font-family:'Instrument Sans';font-weight:600;src:url('${env.PUBLIC_BASE_URL}/designs/fonts/InstrumentSans-SemiBold.ttf') format('truetype')}
@font-face{font-family:'Instrument Sans';font-weight:700;src:url('${env.PUBLIC_BASE_URL}/designs/fonts/InstrumentSans-Bold.ttf') format('truetype')}
@font-face{font-family:'Geist';font-weight:700;src:url('${env.PUBLIC_BASE_URL}/designs/fonts/Geist-Bold.ttf') format('truetype')}
a{color:${C.ink}}
@media (max-width:600px){
  .card{padding:28px 22px 24px !important}
  .h1{font-size:22px !important}
  .banner{width:100% !important;height:auto !important}
}`;

export function layout({ preheader, heading, eyebrow, banner, body }: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(heading)}</title>
<style>${HEAD_CSS}</style>
</head>
<body style="margin:0;padding:0;background-color:${C.cream};">

  <!-- Inbox preview line. Hidden in the message itself. -->
  <div style="display:none;font-size:1px;color:${C.cream};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${esc(preheader)}
    <!-- Padding, or clients pull the body copy in after it. -->
    ${"&#8199;&#65279;&#847; ".repeat(40)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${C.cream};">
    <tr>
      <td align="center" style="padding:32px 12px 40px;background-color:${C.cream};">

        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:560px;">
          <tr>
            <!-- Every cell declares its background beside its colour. Gmail's
                 dark mode decides whether to rewrite a colour by looking at
                 the background on the same element, and a colour on its own
                 gets rewritten into something nobody chose. -->
            <td class="card" style="padding:36px 36px 28px;background-color:${C.white};
                border:1px solid ${C.line};border-radius:16px;font-family:${SANS};">

              <!-- The logo is a picture of the logo, not a wordmark in text:
                   no mail client has the face it is drawn in. The file has a
                   thin white outline round the letters, invisible on this
                   card and the only thing keeping them legible when a client
                   darkens the card behind a transparent image. -->
              <img src="cid:${LOGO_CID}" width="${LOGO.width}" height="${LOGO.height}" alt="Balans"
                   style="display:block;width:${LOGO.width}px;height:${LOGO.height}px;border:0;outline:none;text-decoration:none;">

              ${
                banner
                  ? `<img class="banner" src="cid:${banner.cid}" width="${banner.width}" height="${banner.height}"
                     alt="${esc(banner.alt)}"
                     style="display:block;width:100%;max-width:${banner.width}px;height:auto;margin-top:28px;
                            border:0;outline:none;text-decoration:none;border-radius:16px;">`
                  : ""
              }

              ${
                eyebrow
                  ? `<p style="margin:32px 0 0;font-size:13px;line-height:1.4;font-weight:600;
                              color:${C.muted};background-color:${C.white};">${esc(eyebrow)}</p>`
                  : ""
              }
              <h1 class="h1" style="margin:${eyebrow ? "6px" : banner ? "28px" : "32px"} 0 14px;font-family:${DISPLAY};
                         font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;
                         color:${C.ink};background-color:${C.white};">${esc(heading)}</h1>

              ${body}

              <!-- Footer. Section 12 requires both lines on every email. -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="margin-top:32px;">
                <tr>
                  <td style="border-top:1px solid ${C.line};padding-top:20px;font-family:${SANS};
                      font-size:12px;line-height:1.7;color:${C.muted};background-color:${C.white};">
                    Balans is a product of ${esc(env.LEGAL_ENTITY_NAME)}. Payments are processed by Monnify.<br>
                    <a href="${esc(env.SITE_URL)}/terms" style="color:${C.muted};text-decoration:underline;">Terms</a>
                    &nbsp;·&nbsp;
                    <a href="${esc(env.SITE_URL)}/privacy" style="color:${C.muted};text-decoration:underline;">Privacy</a>
                    &nbsp;·&nbsp;
                    <a href="mailto:${esc(env.SUPPORT_EMAIL)}" style="color:${C.muted};text-decoration:underline;">${esc(env.SUPPORT_EMAIL)}</a><br>
                    © ${new Date().getFullYear()} Balans
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A paragraph of body copy.
 *
 * Takes HTML, not text: several messages set a figure or a warning in bold
 * mid-sentence. Anything a user or a client typed must be escaped by the
 * caller — this used to escape its whole argument, which meant every
 * `<strong>` in the product arrived as visible angle brackets.
 */
export function paragraph(text: string, muted = false): string {
  return `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.7;color:${
    muted ? C.muted : C.body
  };background-color:${C.white};">${text}</p>`;
}

/**
 * The one number the message is about, stated the way the invoices state it.
 *
 * A figure set at reading size in a sentence is a figure people re-read the
 * sentence to find. This is the same move the Statement layout makes: the
 * amount, once, large, with what it is written over it in small caps.
 */
export function amount(label: string, value: string, sub?: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:8px 0 24px;">
    <tr>
      <td style="padding:20px 22px;background-color:${C.panel};border-radius:12px;font-family:${SANS};">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:0.1em;
                  text-transform:uppercase;color:${C.muted};">${esc(label)}</p>
        <p style="margin:0;font-family:${DISPLAY};font-size:30px;line-height:1.1;font-weight:700;
                  letter-spacing:-0.03em;color:${C.ink};">${esc(value)}</p>
        ${
          sub
            ? `<p style="margin:6px 0 0;font-size:13px;line-height:1.5;color:${C.muted};">${esc(sub)}</p>`
            : ""
        }
      </td>
    </tr>
  </table>`;
}

/**
 * The code itself, set large and spaced so it can be read off a phone and typed
 * into another window without losing your place.
 *
 * `user-select:all` lets a tap select the whole thing on mobile, and the digits
 * are spaced but not so far apart that they stop reading as one number.
 */
export function codeBlock(code: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:8px 0 20px;">
    <tr>
      <td align="center" style="background-color:${C.panel};border-radius:12px;padding:22px 16px;">
        <div style="font-family:${DISPLAY};font-size:32px;font-weight:700;letter-spacing:0.24em;
                    color:${C.ink};line-height:1.1;user-select:all;
                    /* The trailing letter-space would push it off-centre. */
                    text-indent:0.24em;">${esc(code)}</div>
      </td>
    </tr>
  </table>`;
}

/**
 * A panel of label-and-value rows.
 *
 * The facts of the message, pulled out of the prose so they can be checked at
 * a glance: a quiet filled panel with hairlines between the rows, and the
 * value on the right where the eye lands looking for it.
 */
export function detailCard(rows: { label: string; value: string }[]): string {
  if (!rows.length) return "";

  const cells = rows
    .map(
      (r, i) => `<tr>
        <td align="left" style="${i ? `border-top:1px solid ${C.line};` : ""}padding:14px 0;font-family:${SANS};
            font-size:14px;line-height:1.45;color:${C.muted};background-color:${C.panel};white-space:nowrap;">${esc(r.label)}</td>
        <td align="right" style="${i ? `border-top:1px solid ${C.line};` : ""}padding:14px 0 14px 16px;font-family:${SANS};
            font-size:14px;line-height:1.45;font-weight:600;color:${C.ink};
            background-color:${C.panel};">${esc(r.value)}</td>
      </tr>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:8px 0 24px;">
    <tr>
      <td style="padding:4px 20px;background-color:${C.panel};border-radius:12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table>
      </td>
    </tr>
  </table>`;
}

/**
 * A short numbered list: what to do first, in order.
 *
 * Each step is a line in bold and a line of explanation. A welcome is the one
 * message that has to teach something, and three things the reader can do
 * teach more than a paragraph about what the product is.
 */
export function steps(items: { title: string; text: string }[]): string {
  if (!items.length) return "";

  const rows = items
    .map(
      (s, i) => `<tr>
        <td width="28" valign="top" style="padding:${i ? "18px" : "2px"} 14px 0 0;background-color:${C.white};">
          <div style="width:26px;height:26px;border-radius:13px;background-color:${C.marigold};
                      font-family:${DISPLAY};font-size:13px;font-weight:700;line-height:26px;
                      text-align:center;color:${C.ink};">${i + 1}</div>
        </td>
        <td valign="top" style="padding:${i ? "18px" : "2px"} 0 0;font-family:${SANS};background-color:${C.white};">
          <p style="margin:0;font-size:15px;line-height:1.5;font-weight:600;color:${C.ink};">${s.title}</p>
          <p style="margin:3px 0 0;font-size:14px;line-height:1.6;color:${C.body};">${s.text}</p>
        </td>
      </tr>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:8px 0 26px;">${rows}</table>`;
}

/**
 * Lines worth setting apart from the prose, against a rule.
 *
 * Used where a message has to state what happened before it says what to do
 * about it — a security notice, most of all.
 */
export function noteBlock(lines: string[]): string {
  if (!lines.length) return "";
  const body = lines
    .map(
      (l, i) =>
        `<p style="margin:${i ? "6px" : "0"} 0 0;font-size:14px;line-height:1.6;color:${C.body};">${esc(l)}</p>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:8px 0 22px;">
    <tr>
      <td style="padding:16px 20px;border-left:3px solid ${C.marigold};border-radius:4px 12px 12px 4px;
          font-family:${SANS};background-color:${C.panel};">${body}</td>
    </tr>
  </table>`;
}

/**
 * The one thing to press.
 *
 * The site's primary button: a marigold pill with ink on it, the width of its
 * own label. Bulletproof enough for Outlook, which renders the padding on the
 * anchor and ignores the radius.
 */
export function button(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
    <tr>
      <td style="background-color:${C.marigold};border-radius:999px;">
        <a href="${esc(href)}"
           style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;line-height:1.2;
                  font-weight:600;color:${C.ink};text-decoration:none;
                  background-color:${C.marigold};border-radius:999px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** A quiet horizontal rule. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:24px 0;"><tr><td style="height:1px;background-color:${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}
