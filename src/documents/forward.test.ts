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

import { quoteButtons, sentMessage } from "./summary.ts";

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

  it("tells the client nothing about converting the quote", () => {
    /*
     * This used to carry "Reply *convert quote 3* when they accept", on the
     * grounds that converting is an action only the sender can take and would
     * otherwise have no way to learn. Both halves of that were true and the
     * conclusion was still wrong: the message is forwarded untouched, so the
     * instruction went to the client — who was told how to convert a quote
     * that is not theirs, by replying to somebody they are not talking to.
     *
     * The sender gets the three actions as buttons on a message of their own
     * instead, which the client never sees. See `quoteButtons`.
     */
    const out = forwardOf({ type: "quote" });
    assert.ok(!out.includes("convert quote"), "the sender's instruction is on the client's copy");
    assert.ok(!/Reply/.test(out), "and it is still telling them to reply to something");
    assert.match(out, /QUOTE/);
    assert.match(out, /Valid until/);
  });

  it("gives the sender the actions as buttons the client never sees", () => {
    // Ids are sentences `commands.ts` already matches, so a tap and a typed
    // reply take one path and there is no second handler to keep in step.
    const ids = quoteButtons(3).map((x) => x.id);
    assert.deepEqual(ids, ["convert quote 3", "resend quote 3", "cancel quote 3"]);

    // Meta caps a reply button title at 20 characters and rejects the message
    // outright if one is longer, which would lose the whole send.
    for (const { title } of quoteButtons(3)) {
      assert.ok(title.length <= 20, `"${title}" is ${title.length} characters`);
    }
  });

  it("works without a due date", () => {
    const out = forwardOf({ dueDate: null });
    assert.match(out, /Sole Capsule/);
    assert.doesNotMatch(out, /Due:/);
  });
});

describe("the price on the message that carries the PDF", () => {
  it("leads with what the two of them agreed, not the naira it converts to", () => {
    /*
     * A £500 quote arrived reading "Amount: ₦963,066.70", with no mention of
     * pounds anywhere on it — on the one message built to be forwarded to the
     * client, quoting a figure they had never seen and never agreed to. The
     * breakdown card one message earlier had it right, which is how the
     * disagreement was spotted.
     *
     * The fifth surface to get this wrong by reading `totalKobo` and assuming
     * naira, after the PDF, the receipt card, the public page and
     * `convertQuote`.
     */
    const out = forwardOf({
      type: "quote",
      totalKobo: 96_306_670,
      subtotalKobo: 89_587_600,
      vatKobo: 6_719_070,
      foreign: { currency: "GBP", amountMinor: 500_00, rate: 1926.1334 },
    });
    assert.match(out, /£500\.00/);
    assert.ok(!out.includes("963,066.70"), "the client is quoted a figure they never agreed");
  });

  it("still says naira on a naira document", () => {
    assert.match(forwardOf(), /₦150,000/);
  });
});
