/**
 * When the money actually lands.
 *
 * Monnify settles once a day, at 22:00 Lagos time, every day of the year —
 * weekends and public holidays included. A payment that arrives before the run
 * goes out that night; one that arrives after it waits for the next.
 *
 * That is the sharpest thing this product can say. "Next business day" means
 * a Friday evening payment sits until Monday, and saying that when it is not
 * true costs us the one line worth leading with. So the wording is computed
 * from the clock rather than written into a message, and it is computed here
 * so every surface says the same thing.
 *
 * Confirmed by Monnify support on 23 September 2026, in writing: "Account
 * transactions settle at 10:00 PM on the same day, including weekends and
 * public holidays."
 *
 * The same reply drew a line this file gets to ignore: card transactions
 * settle at 10:00 PM the *next* day and not at all on weekends or public
 * holidays. Nothing here is paid by card. A client pays an invoice by
 * transfer into an account issued for that one payment — `initBankTransfer`,
 * not the hosted checkout — so every payment `arrivalLine` speaks for is an
 * account transaction. If a card route is ever added, this file is wrong for
 * it and needs to know which kind of payment it is describing.
 */

import { defaults } from "../config.ts";

/** Lagos is UTC+1 all year, so there is no daylight-saving case to handle. */
const LAGOS_OFFSET_MINUTES = 60;

/** The hour of the Lagos day Monnify's payout run goes out. */
export const SETTLEMENT_HOUR = defaults.behaviour.settlementHour;

/** The hour in Lagos, for an instant. */
export function lagosHour(at: Date): number {
  return new Date(at.getTime() + LAGOS_OFFSET_MINUTES * 60_000).getUTCHours();
}

/**
 * Whether a payment made at this instant catches tonight's run.
 *
 * The boundary belongs to the later side: a payment at exactly 22:00 has not
 * beaten the run, and promising somebody their money tonight when it arrives
 * tomorrow is the one error here that costs trust.
 */
export const settlesTonight = (at: Date): boolean => lagosHour(at) < SETTLEMENT_HOUR;

/**
 * The sentence that goes under a payment notification.
 *
 * Said in the second person and in the present tense, because it is a promise
 * about the reader's own money and this is the message they will screenshot.
 */
export function arrivalLine(at: Date): string {
  return settlesTonight(at)
    ? "Arrives in your bank tonight."
    : "Arrives in your bank tomorrow night.";
}
