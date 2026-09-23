/**
 * Corrections that arrive joined together, and the half-change bug.
 *
 * This file exists because of a real message sent to a real draft:
 *
 *   "no make it 400k and due oct 1st"
 *
 * The draft came back due 1 October and still priced at ₦20,000. The date had
 * been applied and the amount had not, and nothing said so — the summary is
 * confident either way, so a half-applied correction reads exactly like a
 * whole one. That is worse than reading nothing at all, which at least asks.
 *
 * Two rules were missing, both about words that carry no meaning of their own:
 *
 *   - "no" in front of a change. It is agreement that the draft is wrong, not
 *     a rejection of it. The reader matched nothing and handed the sentence to
 *     the model, which is a second or two and a guess for a sentence that is
 *     unambiguous.
 *   - "and" between two changes. Every rule cuts its own phrase out and leaves
 *     the join behind, so the date rule handed the amount rule "no make it
 *     400k and" — anchored at both ends, and never going to match.
 *
 * The amount is the field where this matters most, which is why it gets the
 * most cases below: a wrong date is noticed when it arrives, and a wrong price
 * is noticed when the money does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readFileSync } from "node:fs";

import { readCorrection } from "./corrections.ts";

const today = { y: 2026, m: 9, d: 23 };
const N = (naira: number) => naira * 100;

describe("the message that started this", () => {
  it("applies both halves of it", () => {
    const got = readCorrection("no make it 400k and due oct 1st", today);
    assert.equal(got?.totalKobo, N(400_000), "the price was the part that went missing");
    assert.deepEqual(got?.dueDate, { y: 2026, m: 10, d: 1 });
  });

  it("applies both halves however the two are joined", () => {
    // A comma already worked. Nobody types a comma.
    for (const text of [
      "make it 400k and due oct 1st",
      "make it 400k, due oct 1st",
      "make it 400k and due 1 October",
      "change it to 400k and due oct 1st",
    ]) {
      const got = readCorrection(text, today);
      assert.equal(got?.totalKobo, N(400_000), text);
      assert.deepEqual(got?.dueDate, { y: 2026, m: 10, d: 1 }, text);
    }
  });

  it("never returns the date without the amount when both were asked for", () => {
    /*
     * The property, rather than the sentences. Any message carrying a plain
     * amount and a date has to come back with both or with neither, because
     * one of the two silently winning is the whole failure.
     */
    for (const text of [
      "no make it 400k and due oct 1st",
      "ok 400k and due friday",
      "actually make it 400k then due next week",
    ]) {
      const got = readCorrection(text, today);
      assert.ok(got, text);
      assert.equal(
        got.dueDate !== undefined,
        got.totalKobo !== undefined,
        `one half applied and not the other: ${text} -> ${JSON.stringify(got)}`,
      );
    }
  });
});

describe("the noise people put in front of a change", () => {
  it('reads "no" as agreement that the draft is wrong', () => {
    // Not a rejection: the draft is not being thrown away, it is being priced
    // again. "no" on its own is still a rejection, and is read as a command
    // long before this file sees it.
    assert.equal(readCorrection("no make it 400k", today)?.totalKobo, N(400_000));
    assert.equal(readCorrection("no, make it 400k", today)?.totalKobo, N(400_000));
    assert.equal(readCorrection("nope make it 400k", today)?.totalKobo, N(400_000));
  });

  it("steps over the other things people open with", () => {
    for (const text of [
      "ok make it 400k",
      "okay 400k",
      "actually 400k",
      "abeg make it 400k",
      "and make it 400k",
      "please change it to 400k",
    ]) {
      assert.equal(readCorrection(text, today)?.totalKobo, N(400_000), text);
    }
  });

  it("still reads a bare amount, with or without the sign", () => {
    for (const text of ["400k", "₦400k", "n400k", "400,000", "400k abeg"]) {
      assert.equal(readCorrection(text, today)?.totalKobo, N(400_000), text);
    }
  });
});

describe("what it must still refuse", () => {
  it("does not read a rejection as a price", () => {
    // These reach the command reader first, but this file must not be the
    // thing that turns one into an edit if that order ever changes.
    for (const text of ["no", "nope", "no o", "cancel", "wrong"]) {
      assert.equal(readCorrection(text, today)?.totalKobo, undefined, text);
    }
  });

  it("does not take a small bare number for a total", () => {
    // "3" after a draft is a quantity, a line number or a typo far more often
    // than it is three naira, and the invoice floor would refuse it anyway.
    assert.equal(readCorrection("400", today), null);
    assert.equal(readCorrection("no 2", today), null);
  });

  it("does not invent a change out of a sentence with none in it", () => {
    assert.equal(readCorrection("ok thanks", today), null);
    assert.equal(readCorrection("and then what", today), null);
  });

  it("keeps the rest of the message readable after the joins are stripped", () => {
    // The tidying runs between rules, so a client name at the end of a
    // sentence must survive having a date cut off the front of it.
    assert.equal(readCorrection("client is Daniel", today)?.clientName, "Daniel");
    assert.equal(readCorrection("no it's for Tunde", today)?.clientName, "Tunde");
  });

  it("still takes a plan and an amount together", () => {
    const got = readCorrection("ok make it 400k and 50% deposit", today);
    assert.equal(got?.totalKobo, N(400_000));
    assert.equal(got?.depositPercent, 50);
  });
});

describe("how the two readers are wired together", () => {
  /*
   * Read from the source, because the path runs through the database and the
   * WhatsApp client and neither belongs in a parser test. The shape is the
   * guarantee: the free reader is tried first and the model only fills in
   * where it came back with nothing.
   */
  const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");

  it("tries the free reader before spending a model call", () => {
    const free = handle.indexOf("readCorrection(text, today)");
    const model = handle.indexOf("await parseMessage(");
    assert.ok(free > -1 && model > free, "the model is asked first");
    assert.match(handle, /needsParse = NEEDS_PARSE\.has\(state\) && !typedCorrection/);
  });

  it("falls back to the model's reading, in the same shape", () => {
    // One correction path in the machine, not two. A correction a regex read
    // and a correction a model read are the same thing by the time anything
    // acts on them.
    assert.match(handle, /typedCorrection \?\?/);
    assert.match(handle, /reading\.parsed\.correction/);
  });

  it("gives the model the draft, so a reply has a subject", () => {
    assert.match(handle, /draftOnScreen\(saved\.context\.doc\)/);
    assert.match(handle, /parseMessage\(text, \{ today, onScreen \}\)/);
  });
});
