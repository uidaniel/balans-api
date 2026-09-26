/**
 * The number a client reads on a document.
 *
 * The four digits of the platform-wide reference ("BL-0019" is 0019), not the
 * sender's own count. Since 26 September 2026: a client who gets "Invoice 2"
 * from a business can tell it has sent two invoices, and a number that says
 * that is a number the sender did not choose to share.
 *
 * The sender still talks about their own count in the chat ("mark invoice 2
 * as paid"), because that is the list they keep in their head. Falls back to
 * that count on a document from before references existed.
 */
export function clientNumber(ref: string | null | undefined, number: number | null): string | null {
  if (ref) return ref.replace(/^BL-/, "");
  return number === null ? null : String(number);
}
