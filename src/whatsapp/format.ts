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
 * Emoji follow the same logic and a stricter budget: at most one per message,
 * at the very start, and only where it says something the words do not. It is
 * there so a thread of fifteen messages can be scanned at a glance — the
 * receipt, the warning, the one that means money arrived. A tick on every
 * line is the same failure as bold on every line.
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
