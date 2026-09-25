/**
 * WhatsApp text formatting.
 *
 * WhatsApp has its own markup, close to Markdown but not the same: asterisks
 * make bold, not italic, and there is no heading, link or list syntax at all.
 * Getting this wrong shows the reader the punctuation instead of the emphasis.
 *
 * Restraint matters more than the syntax. A message where everything is bold
 * says nothing is important, so the rule applied throughout is: bold marks
 * values and actions — the thing to check, and the thing to do — and never a
 * whole sentence of explanation.
 *
 * Emoji follow the same logic: every message opens with one, chosen for what
 * that message is rather than for decoration. A thread of fifteen messages is
 * then scannable at a glance — the receipt, the warning, the one that means
 * money arrived — because the first character of each says which it is.
 *
 * What ruins that is variety, not quantity. Five different pictures in one
 * message and the eye has nothing to catch on. A single character repeated
 * down a list is the exception, because it is structure rather than emphasis:
 * a tick against each thing a plan includes reads as a list, and every line
 * carries the same weight because they are the same mark.
 *
 * So: one opener, and at most one marker repeated. Anything past that is the
 * same failure as bold on every line. `voice.test.ts` enforces it.
 */

/** Bold. WhatsApp uses single asterisks, unlike Markdown's double. */
export const b = (s: string) => `*${s}*`;

export const i = (s: string) => `_${s}_`;

/** Monospace. Three backticks, and it does not nest with anything else. */
export const mono = (s: string) => "```" + s + "```";

/**
 * Joins lines into one message.
 *
 * Every separate message is a separate charge from October 2026, and a wall of
 * bubbles is harder to read than one organised message. Where two things belong
 * together, they belong in one bubble.
 */
export const lines = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join("\n");

/** A blank line between blocks, for a message with more than one part. */
export const para = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join("\n\n");

/**
 * A labelled value, for the little summaries the bot shows back.
 *
 * The label stays plain and the value carries the weight, because the value is
 * what the reader is checking.
 */
export const field = (label: string, value: string) => `${label}: ${b(value)}`;

/**
 * A bulleted list.
 *
 * WhatsApp renders "- " and "* " as bullets in recent clients but not older
 * ones, where the character simply shows. A middle dot reads correctly either
 * way, so it is used instead.
 */
/**
 * A list WhatsApp draws as one.
 *
 * "- " at the start of a line is WhatsApp's own list syntax: the app sets it
 * as a bullet with a hanging indent, so a long line wraps under its text
 * rather than under the dot. A "·" was only ever a character, and wrapped
 * back to the margin like any other.
 */
export const BULLET = "- ";

export const bullets = (...items: string[]) => items.map((x) => `${BULLET}${x}`).join("\n");

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A horizontal rule.
 *
 * WhatsApp has no headings and no tables, so a rule is the only way to say
 * "this block is one thing". Box-drawing rather than hyphens because a run of
 * hyphens reads as a torn edge, and because WhatsApp turns some hyphen runs
 * into a strikethrough.
 */
export const rule = (width = 18): string => "─".repeat(width);

/**
 * A labelled row: "Client: Zenith Homes".
 *
 * Deliberately not padded into columns. WhatsApp renders in a proportional
 * font, so spaces do not align — padding produces a ragged edge that looks
 * broken rather than tabular. The only way to get true columns is a monospace
 * block, and bold does not survive inside one, which costs more than the
 * alignment is worth: the amount is the thing being checked.
 */
export const row = (label: string, value: string): string => `${label}: ${value}`;

/**
 * A titled block: a heading, a blank line, then its rows.
 *
 *   🧾 *INVOICE DRAFT*
 *
 *   Client: Zenith Homes
 *   Amount: *₦350,000*
 *
 * It used to carry a rule above and below the rows. Every card in the
 * product had two, so a thread of them — a draft, a reminder, a payment
 * — was mostly horizontal lines, and past the second or third the eye
 * stopped reading them as separators and started reading them as noise.
 *
 * The blank line does the same work. WhatsApp already gives a bubble
 * generous line spacing, and a heading with air under it reads as a
 * heading without anything being drawn.
 */
export function block(title: string, rows: (string | false | null | undefined)[]): string {
  const body = rows.filter(Boolean) as string[];
  return [title, "", ...body].join("\n");
}
