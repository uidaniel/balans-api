/**
 * What the client actually receives.
 *
 * The message that carries the PDF is built to be forwarded untouched. That
 * is its whole design: a message that has to be edited before it can be sent
 * is a message that does not get sent. So everything in it has to make sense
 * to somebody who is not the sender.
 *
 * Two things failed that, and both were seen on a real phone before they were
 * caught here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sentMessage } from "./summary.ts";

const TODAY = { y: 2026, m: 9, d: 22 };
const CONFIRMED = { number: 3, publicToken: "5efe26a7cec055801c48a311" };

const draft = (over: Record<string, unknown> = {}) =>
  ({
    type: "invoice",
    clientName: "Sole Capsule",
    clientEmail: null,
    lines: [{ description: "Website Design", qty: 1, unitAmountKobo: 150_000_00 }],
    totalKobo: 150_000_00,
    subtotalKobo: 150_000_00,
    vatKobo: 0,
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    dueDate: { y: 2026, m: 10, d: 8 },
    ...over,
  }) as never;

const forwardOf = (over?: Record<string, unknown>) =>
  sentMessage(draft(over), CONFIRMED, "https://payment.balans.ng", TODAY).forward;

describe("the message a client is forwarded", () => {
  it("does not say which number invoice this is", () => {
    /*
     * It read "INVOICE #3", forwarded whole to the client — telling them this
     * was the third invoice its sender had ever issued. A number that is only
     * a count of how new you are is worse than no number at all, and the
     * client has no use for one here: it is on the document itself, which is
     * where an invoice number belongs.
     */
    const out = forwardOf();
    assert.doesNotMatch(out, /#\s*3\b/, "the heading still carries the count");
    assert.doesNotMatch(out.split("\n")[0]!, /\d/, "the heading should have no number in it");
    assert.match(out, /INVOICE/);
  });

  it("says nothing addressed to the sender", () => {
    // "I will tell you the moment it is paid" only ever reached the client,
    // who has no idea who is being told what.
    const out = forwardOf();
    assert.doesNotMatch(out, /I will tell you/i);
    assert.doesNotMatch(out, /\byou\b/i, "nothing in an invoice is addressed to its reader's sender");
  });

  it("still carries everything the client needs", () => {
    const out = forwardOf();
    assert.match(out, /Sole Capsule/);
    assert.match(out, /₦150,000/);
    assert.match(out, /8 Oct/);
    assert.match(out, /payment\.balans\.ng\/i\/5efe26a7cec055801c48a311/);
  });

  it("keeps the convert instruction on a quote", () => {
    /*
     * The one exception, and it is deliberate. A quote is sent expecting an
     * answer, and converting it is an action only the sender can take and
     * would otherwise have no way to learn. That instruction is worth one
     * odd-looking line; an invoice needs no such thing, because the bot
     * announces the payment by itself.
     */
    const out = forwardOf({ type: "quote" });
    assert.match(out, /convert quote 3/);
    assert.match(out, /QUOTE/);
    assert.match(out, /Valid until/);
  });

  it("works without a due date", () => {
    const out = forwardOf({ dueDate: null });
    assert.match(out, /Sole Capsule/);
    assert.doesNotMatch(out, /Due:/);
  });
});
