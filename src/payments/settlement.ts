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
 * PRD-GAP: the 22:00 run is what Monnify's integration support described for
 * this account's configuration, not something observed. The first real payment
 * between our own accounts is what confirms it, and `SETTLEMENT_HOUR` moves if
 * it lands at some other time.
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
