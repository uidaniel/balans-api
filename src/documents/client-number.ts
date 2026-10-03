/**
 * The number a client reads on a document: the sender's own invoice number,
 * padded to four digits ("0002"), since 3 October 2026.
 *
 * It was the platform-wide reference ("BL-0037" read 0037) from 26 September,
 * so that "Invoice 2" did not tell a client how many invoices a business had
 * sent. The sender's own sequence is the one they expect to see, and they can
 * start it wherever they like in settings ("Next invoice #"). The reference is
 * only the fallback, for a document with no number.
 */
export function clientNumber(ref: string | null | undefined, number: number | null): string | null {
  if (number !== null) return String(number).padStart(4, "0");
  return ref ? ref.replace(/^BL-/, "") : null;
}

/** The same, in SQL, for queries that read it straight into an email. */
export const CLIENT_NUMBER_SQL =
  "COALESCE(LPAD(d.number::text, GREATEST(4, length(d.number::text)), '0'), substring(d.ref from 4))";
