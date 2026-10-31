/**
 * When somebody on Pro may pay for the next month, and what the reminders
 * around the end of a month say.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renewalOpen, type SubscriptionState } from "./subscription.ts";
import { onDayWords, proEnded, proEndingSoon, proGraceEnding, proLapsed, proRenewOffer, proWinBack } from "./messages.ts";

const now = new Date("2026-09-28T10:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const pro = (end: Date | null, inGrace = false): SubscriptionState => ({
  plan: "pro",
  periodEnd: end,
  inGrace,
  collectionMethod: "link",
  owedKobo: 0,
});

describe("renewing Pro", () => {
  it("is not offered with most of the month left: that would be paying twice", () => {
    assert.equal(renewalOpen(pro(days(10)), now), false);
  });

  it("is offered in the last three days", () => {
    assert.equal(renewalOpen(pro(days(2.5)), now), true);
  });

  it("is offered in the grace week after", () => {
    assert.equal(renewalOpen(pro(days(-2), true), now), true);
  });

  it("is never offered to Free, or to Pro with no end date", () => {
    assert.equal(renewalOpen({ ...pro(days(1)), plan: "free" }, now), false);
    assert.equal(renewalOpen(pro(null), now), false);
  });
});

describe("the reminders around the end of a month", () => {
  const all = [
    proEndingSoon(days(3)),
    proEnded(days(0)),
    proGraceEnding(days(-6)),
    proLapsed(),
    proWinBack(),
    proRenewOffer(pro(days(2))),
  ];

  it("all point at the Pay button under them", () => {
    for (const m of all.slice(0, 5)) assert.match(m, /Tap below/, m);
  });

  it("names the day the grace week ends, a week after the month", () => {
    assert.match(proEnded(new Date("2026-09-28T10:00:00Z")), /5 October/);
  });

  it("never says Pro renews by itself", () => {
    for (const m of all) assert.doesNotMatch(m, /renews on|automatically/i, m);
  });
});

describe("when, as somebody reads it", () => {
  // 16 October 2026, 09:50 in Lagos: the morning the notice said "on 17 October".
  const morning = new Date("2026-10-16T08:50:00Z");

  it("says tomorrow for tomorrow, and today for today", () => {
    assert.equal(onDayWords(new Date("2026-10-17T07:00:00Z"), morning), "tomorrow");
    assert.equal(onDayWords(new Date("2026-10-16T22:00:00Z"), morning), "today");
  });

  it("goes by the day in Lagos, not the server's", () => {
    // 23:30 UTC on the 16th is half past midnight on the 17th in Lagos.
    assert.equal(onDayWords(new Date("2026-10-16T23:30:00Z"), morning), "tomorrow");
  });

  it("names the date further off", () => {
    assert.equal(onDayWords(new Date("2026-10-20T10:00:00Z"), morning), "on 20 October");
  });

  it("says the last day of the grace week is tomorrow", () => {
    const ended = new Date("2026-10-10T09:00:00Z");
    const m = proGraceEnding(ended, undefined, morning);
    assert.match(m, /stop tomorrow/);
    assert.doesNotMatch(m, /17 October/);
  });

  it("says Pro ends tomorrow the day before", () => {
    assert.match(proEndingSoon(new Date("2026-10-17T09:00:00Z"), undefined, morning), /ends tomorrow/);
  });
});

describe("somebody whose Pro was a year (31 October 2026)", () => {
  const year = { label: "₦30,000", chargeKobo: 30_000_00, abroad: false, term: "year" as const };
  const end = days(2);

  it("is offered the year first, with the month as the other choice", () => {
    assert.match(proEndingSoon(end, undefined, now, year), /₦30,000 for another year, or ₦3,000 for a month/);
    assert.match(proEnded(end, undefined, now, year), /₦30,000 a year, or ₦3,000 a month/);
    assert.match(proGraceEnding(end, undefined, now, 0, year), /₦30,000 a year, or ₦3,000 a month/);
    assert.match(proLapsed(undefined, 0, year), /₦30,000 a year, or ₦3,000 a month/);
    assert.match(proWinBack(undefined, year), /₦30,000 a year, or ₦3,000 a month/);
  });

  it("leaves a month's reminders as they were", () => {
    assert.match(proEndingSoon(end, undefined, now), /₦3,000 for another month/);
    assert.doesNotMatch(proEnded(end, undefined, now), /a year/);
  });
});

describe("the Pro receipt says how they paid", async () => {
  const { proStarted } = await import("./messages.ts");
  const until = days(30);

  it("names the channel Paystack reports", () => {
    assert.match(proStarted({ paidKobo: 3_000_00, until, method: "card" }), /₦3,000\*, by card,/);
    assert.match(proStarted({ paidKobo: 3_000_00, until, method: "ussd" }), /by USSD/);
  });

  it("does not call every payment a bank transfer", () => {
    assert.doesNotMatch(proStarted({ paidKobo: 3_000_00, until, method: "card" }), /bank transfer/);
    assert.doesNotMatch(proStarted({ paidKobo: 3_000_00, until }), /bank transfer/);
  });
});
