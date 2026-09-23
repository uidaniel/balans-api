/**
 * The shell every Balans email is built in.
 *
 * Email is not the web. Gmail strips much of a `<style>` block, Outlook renders
 * through Word, and neither supports flexbox, grid or custom fonts. So this is
 * tables and inline styles — not because it is nice, but because it is the only
 * thing that arrives looking the same everywhere.
 *
 * The design is the quiet end of the brand: a white sheet on cream, a hairline
 * around it, the wordmark above it and small print below. There is no coloured
 * banner, no full-width button shouting at the reader and no second typeface —
 * the things that make a message look like a marketing template rather than
 * something a person sent. What structure there is comes from rules and space,
 * which is how the invoices themselves are drawn.
 *
 * The brand mark is a real image, attached to the message and referenced by
 * content id rather than fetched from a URL. Gmail and Outlook block remote
 * images by default, so a hosted logo arrives as an empty box for most people
 * on first open; an embedded one always renders, and does not depend on the
 * marketing site being deployed.
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
  /** Body text that is not the heading. A solid value: opacity is unreliable. */
  body: "#3C4B45",
  /** Labels, small print. */
  muted: "#5C6B65",
  /** The hairline everything is separated by. */
  line: "#E7DFCE",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The content id the mark is attached under.
 *
 * Exported so the sender can attach the file with a matching id: the two must
 * agree or the image renders as a broken box.
 */
export const MARK_CID = "balans-mark";

export type LayoutOptions = {
  /** The line shown in the inbox list, after the subject. */
  preheader: string;
  heading: string;
  /** Small caps over the heading: what kind of message this is. Optional. */
  eyebrow?: string;
  /** Already-escaped HTML for the body. */
  body: string;
};

export function layout({ preheader, heading, eyebrow, body }: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(heading)}</title>
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
      <td align="center" style="padding:36px 16px 44px;">

        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:560px;">

          <!-- Wordmark.
               The cell carries an explicit background as well as a colour, and
               it has to. Gmail's dark mode rewrites a colour it considers too
               dark to read, but it decides that by looking at the background
               declared on the same element — and a cell with only a colour on
               it has none to look at. So the page behind the wordmark went
               dark and the ink stayed put, leaving #10231C on near-black:
               legible as nothing but its green cast. -->
          <tr>
            <td style="padding:0 2px 16px;background-color:${C.cream};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="cid:${MARK_CID}" width="26" height="26" alt="Balans"
                         style="display:block;width:26px;height:26px;border:0;outline:none;
                                text-decoration:none;border-radius:13px;">
                  </td>
                  <td style="padding-left:9px;font-family:${FONT};font-size:19px;
                             font-weight:700;letter-spacing:-0.02em;
                             background-color:${C.cream};color:${C.ink};
                             vertical-align:middle;">balans</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- The sheet -->
          <tr>
            <td style="background-color:${C.white};border:1px solid ${C.line};border-radius:14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:34px 32px 30px;font-family:${FONT};background-color:${C.white};">
                    ${
                      eyebrow
                        ? `<p style="margin:0 0 10px;font-size:11px;font-weight:600;
                                     letter-spacing:0.12em;text-transform:uppercase;
                                     color:${C.muted};">${esc(eyebrow)}</p>`
                        : ""
                    }
                    <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;font-weight:700;
                               letter-spacing:-0.015em;color:${C.ink};">${esc(heading)}</h1>
                    ${body}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer. Section 12 requires both lines on every email. -->
          <tr>
            <td style="padding:20px 4px 0;font-family:${FONT};font-size:12px;
                       line-height:1.65;color:${C.muted};background-color:${C.cream};">
              <p style="margin:0;">Balans is a product of ${esc(env.LEGAL_ENTITY_NAME)}.</p>
              <p style="margin:0;">Payments are processed by Monnify.</p>
              <p style="margin:10px 0 0;">
                <a href="${esc(env.PUBLIC_BASE_URL)}/terms" style="color:${C.muted};text-decoration:underline;">Terms</a>
                &nbsp;·&nbsp;
                <a href="${esc(env.PUBLIC_BASE_URL)}/privacy" style="color:${C.muted};text-decoration:underline;">Privacy</a>
                &nbsp;·&nbsp;
                <a href="mailto:${esc(env.SUPPORT_EMAIL)}" style="color:${C.muted};text-decoration:underline;">${esc(env.SUPPORT_EMAIL)}</a>
              </p>
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
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${
    muted ? C.muted : C.body
  };">${text}</p>`;
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
         style="margin:4px 0 22px;">
    <tr>
      <td style="font-family:${FONT};background-color:${C.white};">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.12em;
                  text-transform:uppercase;color:${C.muted};">${esc(label)}</p>
        <p style="margin:0;font-size:32px;line-height:1.1;font-weight:700;
                  letter-spacing:-0.03em;color:${C.ink};">${esc(value)}</p>
        ${
          sub
            ? `<p style="margin:6px 0 0;font-size:13px;color:${C.muted};">${esc(sub)}</p>`
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
         style="margin:20px 0 18px;">
    <tr>
      <td align="center" style="background-color:${C.white};border:1px solid ${C.line};
          border-radius:12px;padding:20px 16px;">
        <div style="font-family:${FONT};font-size:30px;font-weight:700;letter-spacing:0.24em;
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
 * a glance. Hairlines rather than a filled box: the rows are the content, and
 * a coloured card around them only makes the message look like an
 * advertisement for itself.
 */
export function detailCard(rows: { label: string; value: string }[]): string {
  if (!rows.length) return "";

  const cells = rows
    .map(
      (r) => `<tr>
        <td align="left" style="border-top:1px solid ${C.line};padding:11px 0;font-family:${FONT};
            font-size:14px;line-height:1.45;color:${C.muted};background-color:${C.white};">${esc(r.label)}</td>
        <td align="right" style="border-top:1px solid ${C.line};padding:11px 0;font-family:${FONT};
            font-size:14px;line-height:1.45;font-weight:600;color:${C.ink};
            background-color:${C.white};">${esc(r.value)}</td>
      </tr>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:18px 0 22px;border-bottom:1px solid ${C.line};">
    ${cells}
  </table>`;
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
        `<p style="margin:${i ? "6px" : "0"} 0 0;font-size:14px;line-height:1.55;color:${C.body};">${esc(l)}</p>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:18px 0 20px;">
    <tr>
      <td style="padding:2px 0 2px 16px;border-left:2px solid ${C.marigold};
          font-family:${FONT};background-color:${C.white};">${body}</td>
    </tr>
  </table>`;
}

/**
 * The one thing to press, as a pill.
 *
 * Ink rather than marigold, and the width of its own label rather than the
 * width of the message: a full-width yellow bar is the house style of every
 * mailing list, and this is a letter. Bulletproof enough for Outlook, which
 * renders the padding on the anchor and ignores the radius.
 */
export function button(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
    <tr>
      <td style="background-color:${C.ink};border-radius:999px;">
        <a href="${esc(href)}"
           style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;
                  font-weight:600;color:${C.cream};text-decoration:none;
                  background-color:${C.ink};border-radius:999px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** A quiet horizontal rule. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:22px 0;"><tr><td style="height:1px;background-color:${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}
