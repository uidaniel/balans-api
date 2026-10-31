/**
 * When the money actually lands.
 *
 * Every payment Balans confirms is a Paystack one, and Paystack pays out to a
 * subaccount on working days only. Nobody there has put the timing in
 * writing, so the words come from configuration and can be changed the day
 * they do, without a deploy and without hunting for them.
 *
 * Section 9 of the International PRD is blunt about the one thing never to
 * say: "Never use 'tonight' for Paystack payments." Getting that wrong is not
 * a wording mistake, it is telling somebody their money arrives tonight when
 * it does not. So the sentence is decided here, once, and every surface says
 * the same thing.
 */

import { defaults } from "../config.ts";

/** Lagos is UTC+1 all year, so there is no daylight-saving case to handle. */
const LAGOS_OFFSET_MINUTES = 60;

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The Lagos calendar day of an instant, as midnight UTC of that date. */
function lagosDay(at: Date): Date {
  const local = new Date(at.getTime() + LAGOS_OFFSET_MINUTES * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** `n` working days after `day`, Saturdays and Sundays skipped. */
function workingDaysAfter(day: Date, n: number): Date {
  const d = new Date(day);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left -= 1;
  }
  return d;
}

const dayName = (d: Date) => `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;

/**
 * The sentence that goes under a payment notification.
 *
 * Said in the second person and in the present tense, because it is a promise
 * about the reader's own money and this is the message they will screenshot.
 *
 * Named in days (17 October 2026), from the day it was paid: paid on Friday
 * 16 Oct is "between Monday 19 Oct and Tuesday 20 Oct". "24–48 hours" on a
 * Friday left the reader to work out that it meant Monday or Tuesday.
 */
export function arrivalLine(at: Date): string {
  const [first, last] = defaults.international.settlementWorkingDays;
  const day = lagosDay(at);
  const from = workingDaysAfter(day, first);
  const to = workingDaysAfter(day, last);
  return from.getTime() === to.getTime()
    ? `Usually in your bank on ${dayName(from)}.`
    : `Usually in your bank between ${dayName(from)} and ${dayName(to)}.`;
}

/**
 * The sentence on the breakdown card, before anybody has paid.
 *
 * `arrivalLine` speaks about money that has already moved; this speaks about
 * money that has not, so it is a forecast rather than a report, and it is
 * configuration's words rather than a computed day: the card is drawn before
 * anybody knows which day the client will pay.
 */
export function settlesLine(): string {
  return defaults.international.settlementText;
}
