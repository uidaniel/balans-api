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
 * Emoji follow the same logic, with a budget of exactly one: every message
 * opens with one, no message carries a second, and it is chosen for what that
 * message is rather than decoration. A thread of fifteen messages is then
 * scannable at a glance — the receipt, the warning, the one that means money
 * arrived — because the first character of each says which it is.
 *
 * One per message is the whole discipline. A tick on every line inside a
 * message is the same failure as bold on every line: it stops meaning
 * anything, and the one place it mattered no longer stands out.
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
export const bullets = (...items: string[]) => items.map((x) => `· ${x}`).join("\n");

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
 * A titled block with a rule above and below its rows.
 *
 *   🧾 *INVOICE DRAFT*
 *   ──────────────────
 *   Client: Zenith Homes
 *   Amount: *₦350,000*
 *   ──────────────────
 *
 * The footer sits outside the rules, because it is the instruction rather
 * than part of the record.
 */
export function block(title: string, rows: (string | false | null | undefined)[]): string {
  const body = rows.filter(Boolean) as string[];
  return [title, rule(), ...body, rule()].join("\n");
}
