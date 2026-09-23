/**
 * The shell every Balans email is built in.
 *
 * Email is not the web. Gmail strips much of a `<style>` block, Outlook renders
 * through Word, and neither supports flexbox or grid. So this is tables and
 * inline styles — not because it is nice, but because it is the only thing
 * that arrives looking the same everywhere.
 *
 * The design is WebTopper's, as it arrives on a phone: the message on a
 * near-white sheet with a hairline across the top of it, the logo 32px under
 * that, then a heading, a few lines of prose, the facts in a quiet panel, one
 * button, and the small print under another hairline. On a desktop the sheet
 * is a card on a grey page; under 480px the card stops being one, because a
 * rounded shape inside a phone's square screen is two outlines disagreeing
 * about the same corner.
 *
 * Set in the system's own sans. A web font would have to be fetched on open,
 * which Gmail refuses outright and which tells whoever serves the file that
 * the message was read. This is the one place the brand gives ground on
 * purpose.
 *
 * Images travel with the message and are referenced by content id rather than
 * fetched from a URL. Gmail and Outlook block remote images by default, so a
 * hosted logo arrives as an empty box for most people on first open.
 *
 * PRD section 12 requires two lines on every email, and they are in the footer
 * where they cannot be forgotten.
 */

import { env } from "../config.ts";

/**
 * Hex, because email has no custom properties.
 *
 * The neutrals are WebTopper's, deliberately. They are chosen to survive
 * Gmail's dark mode, which inverts by its own rules: a warm cream panel came
 * back from it a muddy brown, and these come back as greys. The brand is in
 * the ink, the marigold and the mark.
 */
const LIGHT = {
  paper: "#FCFCFB",
  mist: "#F0F1ED",
  line: "#DFE0DA",
  faint: "#71746A",
  slate: "#5F6259",
  ink: "#10231C",
  marigold: "#F5B82E",
  /** The page behind the card on a desktop. Mist is too close to paper to separate. */
  canvas: "#E9EAE4",
} as const;

/** For the clients that honour `prefers-color-scheme`. */
const DARK = {
  paper: "#101210",
  mist: "#1A1D19",
  line: "#2A2E28",
  faint: "#84887C",
  slate: "#A5A99D",
  ink: "#F2F3EE",
  marigold: "#F5B82E",
  canvas: "#080907",
} as const;

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const WIDTH = 600;
/** Horizontal padding either side of the column. 32px reads well from 320px up. */
const GUTTER = 32;
const RADIUS = 8;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Common to every paragraph: no inherited margin, and the stack. */
const P = `margin:0;font-family:${FONT};`;

/**
 * The content id the coin is attached under.
 *
 * Exported so the sender can attach the file with a matching id: the two must
 * agree or the image renders as a broken box.
 */
export const MARK_CID = "balans-mark";

/** The coin's size in the message. The file is three times this. */
const MARK = 26;

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

/**
 * The dark palette, and why it is a `<style>` element rather than inline.
 *
 * Inline styles cannot carry a media query, so the light palette is inlined
 * (which is what clients that strip `<style>` will show) and the dark palette
 * overrides it here. `!important` is not optional: it is beating an inline
 * style, which otherwise always wins.
 *
 * Gmail ignores `prefers-color-scheme` and inverts colours by its own rules,
 * which is why the light design is built to survive being inverted rather
 * than relying on this.
 */
function styles(): string {
  return `
      body { margin:0 !important; padding:0 !important; width:100% !important; }
      table { border-collapse:collapse; }
      img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
      a { color:${LIGHT.ink}; }
      /* Stop iOS turning dates and amounts into blue links of its own. */
      a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
      @media (prefers-color-scheme: dark) {
        .bl-canvas { background:${DARK.canvas} !important; }
        .bl-card { background:${DARK.paper} !important; border-color:${DARK.line} !important; }
        .bl-ink { color:${DARK.ink} !important; }
        .bl-slate { color:${DARK.slate} !important; }
        .bl-faint, .bl-faint a { color:${DARK.faint} !important; }
        .bl-mist { background:${DARK.mist} !important; }
        .bl-rule { border-color:${DARK.line} !important; }
      }
      @media only screen and (max-width: 480px) {
        /* Edge to edge. Below 480px there is no room for a card to be a
           card, so it keeps the hairline along its top and stops there. */
        .bl-shell { padding:0 !important; }
        .bl-card { border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
        .bl-pad { padding-left:22px !important; padding-right:22px !important; }
      }`;
}

/**
 * The logo: the coin as a picture, the name as text.
 *
 * The name was a picture too, and Gmail's dark mode showed why it cannot be:
 * it recolours text and leaves images alone, so the ink letters sat on its
 * dark page with nothing to read them by. As text, every client colours it
 * for its own background. The coin stays a picture because marigold and ink
 * read on either.
 *
 * The name is in the system's bold rather than the logo's face, which no mail
 * client has. Same size, weight and tracking as the drawn one.
 */
function logoHtml(): string {
  return `<a href="${esc(env.SITE_URL)}" style="text-decoration:none;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" style="padding-right:8px;font-size:0;line-height:0;">
          <img src="cid:${MARK_CID}" width="${MARK}" height="${MARK}" alt=""
               style="display:block;width:${MARK}px;height:${MARK}px;border:0;outline:none;text-decoration:none;">
        </td>
        <td valign="middle" style="font-family:${FONT};font-size:21px;line-height:26px;font-weight:700;letter-spacing:-0.035em;color:${LIGHT.ink};" class="bl-ink">balans</td>
      </tr></table>
    </a>`;
}

/** One padded row of the column. Everything in the body is one of these. */
const row = (inner: string, padTop: number) =>
  `<tr><td class="bl-pad" style="padding:${padTop}px ${GUTTER}px 0 ${GUTTER}px;">${inner}</td></tr>`;

export function layout({ preheader, heading, eyebrow, banner, body }: LayoutOptions): string {
  const year = new Date().getUTCFullYear();

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${esc(heading)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style type="text/css">${styles()}
</style>
</head>
<body style="margin:0;padding:0;background:${LIGHT.canvas};" class="bl-canvas">
<!-- Preheader: what the inbox list shows after the subject. The trailing
     entities push the body copy out of the preview, which otherwise runs on
     with whatever the first paragraph happens to start with. -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${LIGHT.canvas};">${esc(preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${LIGHT.canvas};" class="bl-canvas">
<tr><td align="center" class="bl-shell" style="padding:40px 0;">

<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${WIDTH}"><tr><td><![endif]-->
<!-- Fluid to the viewport, capped at ${WIDTH}px. Outlook ignores max-width,
     so it gets the fixed table above instead. -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:${WIDTH}px;background:${LIGHT.paper};border:1px solid ${LIGHT.line};border-radius:14px;" class="bl-card bl-rule">

  <tr><td class="bl-pad" style="padding:32px ${GUTTER}px 4px ${GUTTER}px;">${logoHtml()}</td></tr>

  ${
    banner
      ? row(
          `<img src="cid:${banner.cid}" width="${banner.width}" height="${banner.height}" alt="${esc(banner.alt)}"
               style="display:block;width:100%;max-width:${banner.width}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:12px;">`,
          24,
        )
      : ""
  }

  ${
    eyebrow
      ? row(
          `<p style="${P}font-size:13px;line-height:20px;font-weight:600;color:${LIGHT.faint};" class="bl-faint">${esc(eyebrow)}</p>`,
          28,
        )
      : ""
  }
  ${row(
    `<h1 style="${P}font-size:22px;line-height:30px;font-weight:600;color:${LIGHT.ink};letter-spacing:-0.01em;" class="bl-ink">${esc(heading)}</h1>`,
    eyebrow ? 4 : 28,
  )}

  ${row(body, 0)}

  <tr><td class="bl-pad" style="padding:32px ${GUTTER}px 0 ${GUTTER}px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:1px solid ${LIGHT.line};font-size:0;line-height:0;" class="bl-rule">&nbsp;</td></tr></table>
  </td></tr>

  <!-- Footer. Section 12 requires both lines on every email. -->
  <tr><td class="bl-pad" style="padding:16px ${GUTTER}px 28px ${GUTTER}px;font-family:${FONT};">
    <p style="${P}font-size:12px;line-height:18px;color:${LIGHT.faint};" class="bl-faint">
      Balans is a product of ${esc(env.LEGAL_ENTITY_NAME)}. Payments are processed by Monnify.<br />
      <a href="${esc(env.SITE_URL)}/terms" style="color:${LIGHT.faint};text-decoration:underline;">Terms</a>
      &middot; <a href="${esc(env.SITE_URL)}/privacy" style="color:${LIGHT.faint};text-decoration:underline;">Privacy</a>
      &middot; <a href="mailto:${esc(env.SUPPORT_EMAIL)}" style="color:${LIGHT.faint};text-decoration:underline;">${esc(env.SUPPORT_EMAIL)}</a><br />
      &copy; ${year} Balans
    </p>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Each piece carries its own space above it and none below, so they stack in
 * any order with the same rhythm: 16px between lines of prose, 20px before a
 * panel, 24px before a button or a figure.
 */

/**
 * A paragraph of body copy.
 *
 * Takes HTML, not text: several messages set a figure or a warning in bold
 * mid-sentence. Anything a user or a client typed must be escaped by the
 * caller — this used to escape its whole argument, which meant every
 * `<strong>` in the product arrived as visible angle brackets.
 */
export function paragraph(text: string, muted = false): string {
  return `<p style="${P}padding-top:16px;font-size:15px;line-height:24px;color:${
    muted ? LIGHT.faint : LIGHT.slate
  };" class="${muted ? "bl-faint" : "bl-slate"}">${text}</p>`;
}

/**
 * The one number the message is about, at the size that says so.
 *
 * A figure set at reading size in a sentence is a figure people re-read the
 * sentence to find: the amount, once, large, with what it is over it in
 * small caps.
 */
export function amount(label: string, value: string, sub?: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:24px;font-family:${FONT};">
<p style="${P}font-size:11px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;color:${LIGHT.faint};" class="bl-faint">${esc(label)}</p>
<p style="${P}padding-top:6px;font-size:38px;line-height:42px;font-weight:600;letter-spacing:-0.02em;color:${LIGHT.ink};" class="bl-ink">${esc(value)}</p>
${sub ? `<p style="${P}padding-top:6px;font-size:13px;line-height:20px;color:${LIGHT.faint};" class="bl-faint">${esc(sub)}</p>` : ""}
</td></tr></table>`;
}

/**
 * The code itself, set large and spaced so it can be read off a phone and typed
 * into another window without losing your place.
 */
export function codeBlock(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${LIGHT.mist};border-radius:${RADIUS}px;" class="bl-mist"><tr>
<td align="center" style="padding:18px 16px;font-family:${MONO};font-size:30px;line-height:36px;font-weight:600;letter-spacing:0.24em;text-indent:0.24em;color:${LIGHT.ink};" class="bl-ink">${esc(code)}</td>
</tr></table>
</td></tr></table>`;
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
<td style="padding:10px 0;${i > 0 ? `border-top:1px solid ${LIGHT.line};` : ""}font-family:${FONT};font-size:13px;line-height:20px;color:${LIGHT.faint};white-space:nowrap;" class="bl-faint bl-rule">${esc(r.label)}</td>
<td align="right" style="padding:10px 0 10px 16px;${i > 0 ? `border-top:1px solid ${LIGHT.line};` : ""}font-family:${FONT};font-size:13px;line-height:20px;font-weight:600;color:${LIGHT.ink};" class="bl-ink bl-rule">${esc(r.value)}</td>
</tr>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${LIGHT.mist};border-radius:${RADIUS}px;" class="bl-mist"><tr><td style="padding:6px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>
</td></tr></table>
</td></tr></table>`;
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
<td valign="top" width="30" style="padding:${i ? 14 : 0}px 12px 0 0;">
  <div style="width:22px;height:22px;border-radius:11px;background:${LIGHT.marigold};font-family:${FONT};font-size:12px;line-height:22px;font-weight:700;text-align:center;color:${LIGHT.ink};">${i + 1}</div>
</td>
<td valign="top" style="padding:${i ? 14 : 0}px 0 0 0;font-family:${FONT};">
  <p style="${P}font-size:15px;line-height:22px;font-weight:600;color:${LIGHT.ink};" class="bl-ink">${s.title}</p>
  <p style="${P}padding-top:2px;font-size:15px;line-height:24px;color:${LIGHT.slate};" class="bl-slate">${s.text}</p>
</td>
</tr>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
</td></tr></table>`;
}

/**
 * Lines worth setting apart from the prose.
 *
 * Used where a message has to state what happened before it says what to do
 * about it — a security notice, most of all.
 */
export function noteBlock(lines: string[]): string {
  if (!lines.length) return "";
  const body = lines
    .map(
      (l, i) =>
        `<p style="${P}${i ? "padding-top:4px;" : ""}font-size:13px;line-height:20px;color:${LIGHT.slate};" class="bl-slate">${esc(l)}</p>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${LIGHT.mist};border-radius:${RADIUS}px;" class="bl-mist"><tr><td style="padding:14px 18px;font-family:${FONT};">${body}</td></tr></table>
</td></tr></table>`;
}

/**
 * The one thing to press: the site's marigold pill, with ink on it.
 *
 * Outlook's Word engine ignores padding and border-radius on an anchor, so a
 * styled `<a>` collapses to bare underlined text on the one client where that
 * looks most broken. The VML shape behind the conditional comment is the
 * long-standing fix: Outlook draws the shape, and every other client ignores
 * the comment and uses the anchor.
 */
export function button(label: string, href: string): string {
  const h = esc(href);
  const l = esc(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-top:24px;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:46px;v-text-anchor:middle;width:260px;" arcsize="50%" stroke="f" fillcolor="${LIGHT.marigold}">
<w:anchorlock/><center style="color:${LIGHT.ink};font-family:${FONT};font-size:15px;font-weight:600;">${l}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${h}" style="background:${LIGHT.marigold};border-radius:999px;color:${LIGHT.ink};display:inline-block;font-family:${FONT};font-size:15px;font-weight:600;line-height:46px;text-align:center;text-decoration:none;min-width:200px;padding:0 28px;mso-hide:all;">${l}</a>
<!--<![endif]-->
</td></tr></table>`;
}

/** A quiet horizontal rule. */
export function divider(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding-top:24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:1px solid ${LIGHT.line};font-size:0;line-height:0;" class="bl-rule">&nbsp;</td></tr></table>
</td></tr></table>`;
}
