/**
 * Every word that names a ready design, by id and by the name the picker
 * shows (9 November 2026). Plain strings, so the conversation machine can tell
 * "use Slip design" from "I want logo design for Tunde" without importing the
 * templates. design-names.test.ts keeps it in step with TEMPLATES.
 */
export const DESIGN_WORDS: ReadonlySet<string> = new Set([
  "classic", "wordmark", "glare", "adire", "statement", "ledger", "monolith", "fluted", "editorial", "atelier",
  "folio", "swiss", "poster", "ticket", "bento", "gazette", "slip", "letterhead", "meridian", "blueprint", "frost",
  "angle", "halftone", "monogram",
]);
