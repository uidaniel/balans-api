/**
 * When somebody on Pro may pay for the next month, and what the reminders
 * around the end of a month say.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renewalOpen, type SubscriptionState } from "./subscription.ts";
import { proEnded, proEndingSoon, proGraceEnding, proLapsed, proRenewOffer, proWinBack } from "./messages.ts";

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

  it("all say how to keep Pro", () => {
    for (const m of all.slice(0, 5)) assert.match(m, /upgrade/, m);
  });

  it("names the day the grace week ends, a week after the month", () => {
    assert.match(proEnded(new Date("2026-09-28T10:00:00Z")), /5 October/);
  });

  it("never says Pro renews by itself", () => {
    for (const m of all) assert.doesNotMatch(m, /renews on|automatically/i, m);
  });
});
