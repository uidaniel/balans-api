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
 * The same reply drew a line about cards: they settle at 10:00 PM the *next*
 * day and not at all on weekends or public holidays. That line used to be
 * safe to ignore, because every payment this file spoke for was a transfer
 * into an account issued for it.
 *
 * It is not safe any more. An invoice priced in dollars or pounds is paid by
 * card through Paystack (International PRD section 8), on somebody else's
 * settlement schedule entirely — so this file now has to be told which kind
 * of payment it is describing. Section 9 is blunt about it: "Never use
 * 'tonight' for Paystack payments." Getting that wrong is not a wording
 * mistake, it is telling somebody their money arrives tonight when it does
 * not.
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
export function arrivalLine(at: Date, provider: "monnify" | "paystack" = "monnify"): string {
  /*
   * A card is on Paystack's schedule, which nobody has confirmed in writing
   * yet — so the sentence comes from configuration and can be changed the day
   * they do, without a deploy and without hunting for it.
   *
   * Never "tonight": we know the hour of Monnify's run, not Paystack's. What
   * we do know is that it pays out on working days only, so the window is
   * named in days (17 October 2026): "24–48 hours" on a Friday left the
   * reader to work out that it meant Monday or Tuesday.
   */
  if (provider === "paystack") return cardArrivalLine(at);

  return settlesTonight(at)
    ? "Arrives in your bank tonight."
    : "Arrives in your bank tomorrow night.";
}

/**
 * The sentence on the breakdown card, before anybody has paid.
 *
 * `arrivalLine` speaks about money that has already moved; this speaks about
 * money that has not, so it is a forecast rather than a report and it says the
 * hour out loud. "Settles tonight" alone invites the reader to supply their own
 * idea of tonight, and somebody refreshing their banking app at 11 PM having
 * read it at noon is the version of this that loses trust.
 *
 * The boundary is the same one `settlesTonight` draws, and drawn there for the
 * same reason: 22:00 belongs to tomorrow. A card is on Paystack's schedule and
 * gets configuration's words, never a computed hour — section 9 forbids
 * "tonight" for a card, and it would be a promise about somebody else's payout
 * run that nobody has confirmed.
 */
export function settlesLine(at: Date, provider: "monnify" | "paystack" = "monnify"): string {
  if (provider === "paystack") return defaults.international.settlementText;

  const hour = SETTLEMENT_HOUR > 12 ? SETTLEMENT_HOUR - 12 : SETTLEMENT_HOUR;
  return settlesTonight(at)
    ? `Settles tonight by ${hour}pm`
    : `Settles tomorrow by ${hour}pm`;
}

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
 * When a card payment that landed at `at` reaches the bank, as two named
 * days: paid on Friday 16 Oct, "between Monday 19 Oct and Tuesday 20 Oct".
 */
export function cardArrivalLine(at: Date): string {
  const [first, last] = defaults.international.settlementWorkingDays;
  const day = lagosDay(at);
  const from = workingDaysAfter(day, first);
  const to = workingDaysAfter(day, last);
  return from.getTime() === to.getTime()
    ? `Usually in your bank on ${dayName(from)}.`
    : `Usually in your bank between ${dayName(from)} and ${dayName(to)}.`;
}
