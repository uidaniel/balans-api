/**
 * The shell every Balans email is built in.
 *
 * Email is not the web. Gmail strips much of a `<style>` block, Outlook renders
 * through Word, and neither supports flexbox, grid or custom fonts. So this is
 * tables and inline styles — not because it is nice, but because it is the only
 * thing that arrives looking the same everywhere.
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
  ink2: "#173128",
  marigold: "#F5B82E",
  cream: "#F6F1E7",
  sand: "#E9E1D0",
  white: "#FFFFFF",
  /** Muted body text on cream. A solid value: opacity is unreliable in email. */
  muted: "#5C6B65",
  line: "#DFD7C6",
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
  /** Already-escaped HTML for the body. */
  body: string;
};

export function layout({ preheader, heading, body }: LayoutOptions): string {
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
      <td align="center" style="padding:32px 16px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:600px;">

          <!-- Wordmark.
               The cell carries an explicit background as well as a colour, and
               it has to. Gmail's dark mode rewrites a colour it considers too
               dark to read, but it decides that by looking at the background
               declared on the same element — and a cell with only a colour on
               it has none to look at. So the page behind the wordmark went
               dark and the ink stayed put, leaving #10231C on near-black:
               legible as nothing but its green cast. -->
          <tr>
            <td style="padding:0 4px 20px;background-color:${C.cream};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="cid:${MARK_CID}" width="34" height="34" alt="Balans"
                         style="display:block;width:34px;height:34px;border:0;outline:none;
                                text-decoration:none;border-radius:17px;">
                  </td>
                  <td style="padding-left:10px;font-family:${FONT};font-size:19px;
                             font-weight:700;letter-spacing:-0.02em;
                             background-color:${C.cream};color:${C.ink};
                             vertical-align:middle;">balans</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:${C.white};border-radius:20px;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <!-- The marigold rule, as on the Classic invoice -->
                <tr><td style="height:5px;background-color:${C.marigold};font-size:0;line-height:0;">&nbsp;</td></tr>
                <tr>
                  <td style="padding:36px 32px 32px;font-family:${FONT};">
                    <h1 style="margin:0 0 18px;font-size:23px;line-height:1.25;font-weight:700;
                               letter-spacing:-0.02em;color:${C.ink};">${esc(heading)}</h1>
                    ${body}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer. Section 12 requires both lines on every email. -->
          <tr>
            <td style="padding:24px 8px 0;font-family:${FONT};font-size:12px;
                       line-height:1.6;color:${C.muted};">
              <p style="margin:0;">Balans is a product of ${esc(env.LEGAL_ENTITY_NAME)}.</p>
              <p style="margin:0;">Payments processed by Monnify.</p>
              <p style="margin:12px 0 0;">
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

export function paragraph(text: string, muted = false): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${
    muted ? C.muted : C.ink
  };">${esc(text)}</p>`;
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
         style="margin:22px 0 20px;">
    <tr>
      <td align="center" style="background-color:${C.sand};border-radius:14px;padding:22px 16px;">
        <div style="font-family:${FONT};font-size:34px;font-weight:700;letter-spacing:0.22em;
                    color:${C.ink};line-height:1.1;user-select:all;
                    /* The trailing letter-space would push it off-centre. */
                    text-indent:0.22em;">${esc(code)}</div>
      </td>
    </tr>
  </table>`;
}

/**
 * A panel of label-and-value rows.
 *
 * The facts of the message, pulled out of the prose so they can be checked at
 * a glance: what the plan is, when it renews, which number we will message.
 * Somebody scanning an email reads the bold right-hand column and nothing
 * else, and this is the shape that rewards that.
 */
export function detailCard(rows: { label: string; value: string }[]): string {
  if (!rows.length) return "";

  const cells = rows
    .map((r, i) => {
      const border = i === 0 ? "" : `border-top:1px solid ${C.line};`;
      return `<tr>
        <td align="left" style="${border}padding:13px 18px;font-family:${FONT};font-size:14px;
            line-height:1.45;color:${C.muted};">${esc(r.label)}</td>
        <td align="right" style="${border}padding:13px 18px;font-family:${FONT};font-size:14px;
            line-height:1.45;font-weight:700;color:${C.ink};">${esc(r.value)}</td>
      </tr>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:22px 0;background-color:${C.cream};border-radius:14px;">
    ${cells}
  </table>`;
}

/**
 * A filled button that still looks like one in Outlook.
 *
 * Marigold with ink text, and the full width of the card. It is the one thing
 * on the page anybody is meant to press, and a button the width of its own
 * label does not read that way on a phone.
 */
export function button(label: string, href: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
    <tr>
      <td align="center" style="background-color:${C.marigold};border-radius:12px;">
        <a href="${esc(href)}"
           style="display:block;padding:15px 24px;font-family:${FONT};font-size:16px;
                  font-weight:700;color:${C.ink};text-decoration:none;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** A quiet horizontal rule. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="margin:22px 0;"><tr><td style="height:1px;background-color:${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}
