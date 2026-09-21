/**
 * Writing a person's name the way they would write it.
 *
 * People type "edidiong uwak" into a chat because a phone keyboard does not
 * capitalise mid-sentence, and then it lands on an invoice a client reads. A
 * name in lower case makes the document look like it was made carelessly,
 * which is the opposite of what an invoice is for.
 */

/**
 * Words that stay lower case inside a longer name.
 *
 * "Bank of the North", not "Bank Of The North". Never applied to the first
 * word, which is always capitalised however small it is.
 */
const MINOR = new Set(["of", "the", "and", "for", "in", "on", "at", "to", "by", "de", "da", "van", "von"]);

/**
 * Capitalises a name without destroying deliberate capitals.
 *
 * A word that already contains a capital is left exactly as it is, so "MTN",
 * "MoMo", "iCreate" and "O'Brien" survive. Only all-lower-case words are
 * touched, because those are the ones a keyboard produced rather than a
 * person choosing.
 */
export function titleCaseName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return name;

  const words = name.split(" ");

  return words
    .map((word, i) => {
      // Already has a capital somewhere: their choice, not ours to change.
      if (/[A-Z]/.test(word)) return word;

      const lower = word.toLowerCase();
      if (i > 0 && MINOR.has(lower)) return lower;

      // Capitalise after an apostrophe or a hyphen too: "o'brien" is
      // "O'Brien" and "ada-obi" is "Ada-Obi".
      return lower.replace(/(^|[''’-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
    })
    .join(" ");
}
