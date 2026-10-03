/**
 * The currency somebody most likely lives in, from their WhatsApp number.
 *
 * Only an ordering hint: it puts their own money at the top of the currency
 * box. It never prices anything and never decides what a message meant, so a
 * wrong guess costs a scroll, not an invoice. Naira when the number says
 * nothing we take.
 *
 * +1 is shared by the US and Canada; Canada is told apart by its area codes.
 */

import type { Currency } from "./currency.ts";

const CANADA_AREA_CODES = new Set([
  "204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365", "367", "368", "382",
  "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548",
  "579", "581", "584", "587", "604", "613", "639", "647", "672", "683", "705", "709", "742", "753",
  "778", "780", "782", "807", "819", "825", "867", "873", "879", "902", "905",
]);

/** Euro area calling codes. */
const EURO = [
  "30", "31", "32", "33", "34", "39", "43", "49", "351", "352", "353", "356", "357", "358",
  "370", "371", "372", "377", "378", "381", "382", "385", "386", "421",
];

/** Longest prefix first, so +233 is Ghana and never "+23…" anything else. */
const PREFIXES: [string, Currency][] = (
  [
    ["234", "NGN"],
    ["233", "GHS"],
    ["254", "KES"],
    ["971", "AED"],
    ["44", "GBP"],
    ["61", "AUD"],
    ["27", "ZAR"],
    ...EURO.map((p) => [p, "EUR"] as [string, Currency]),
  ] as [string, Currency][]
).sort((a, b) => b[0].length - a[0].length);

export function homeCurrencyFor(phone: string | null | undefined): Currency {
  const digits = String(phone ?? "").replace(/\D/g, "").replace(/^00/, "");
  if (!digits) return "NGN";
  if (digits.startsWith("1") && digits.length === 11) {
    return CANADA_AREA_CODES.has(digits.slice(1, 4)) ? "CAD" : "USD";
  }
  for (const [prefix, currency] of PREFIXES) if (digits.startsWith(prefix)) return currency;
  return "NGN";
}
