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

/**
 * Building a longer invoice by typing, because the form cannot.
 *
 * A WhatsApp Flow has no repeating list, no way to redraw a screen in place,
 * and at most two tappable links on a screen. Five items is as far as the
 * form goes, and every item past the first costs a screen. A sentence has
 * none of those limits and this reader already handles the hard part.
 */
describe("adding and removing whole lines", () => {
  const today = { y: 2026, m: 9, d: 23 } as const;
  const read = (s: string) => readCorrection(s, today);

  it("adds a line from the way people actually write one", () => {
    for (const [said, description, kobo] of [
      ["add SEO 100k", "SEO", 100_000_00],
      ["add seo for 100000", "seo", 100_000_00],
      ["also add hosting 20k", "hosting", 20_000_00],
      ["add another item: business cards 5k", "business cards", 5_000_00],
      ["include photography for N75,000", "photography", 75_000_00],
    ] as const) {
      assert.deepEqual(read(said)?.addLines, [{ description, unitAmountKobo: kobo }], said);
    }
  });

  it("reads several at once, joined however they were joined", () => {
    assert.deepEqual(read("add SEO 100k and hosting 20k")?.addLines, [
      { description: "SEO", unitAmountKobo: 100_000_00 },
      { description: "hosting", unitAmountKobo: 20_000_00 },
    ]);

    /*
     * "design" begins with the letter the naira prefix used to match, so the
     * money pattern ate it: this came back as an item called "logo desig".
     */
    assert.deepEqual(read("add logo design 50k, hosting 20k, cards 5k")?.addLines, [
      { description: "logo design", unitAmountKobo: 50_000_00 },
      { description: "hosting", unitAmountKobo: 20_000_00 },
      { description: "cards", unitAmountKobo: 5_000_00 },
    ]);
  });

  it("takes a line off by its number or by its name", () => {
    assert.deepEqual(read("remove item 2")?.removeLine, { position: 2 });
    assert.deepEqual(read("take off item 3")?.removeLine, { position: 3 });
    assert.deepEqual(read("remove the SEO line")?.removeLine, { match: "SEO" });
    assert.deepEqual(read("delete the hosting")?.removeLine, { match: "hosting" });
  });

  it("does not mistake the options for lines", () => {
    // Each of these has its own rule, and each says "add" or "remove".
    assert.equal(read("add vat")?.vatPercent, 7.5);
    assert.equal(read("remove the vat")?.vatPercent, null);
    assert.equal(read("remove the deposit")?.depositPercent, null);
    // "add 50% deposit" left the word "add" behind, and a leftover used to
    // mean "I did not understand this message".
    assert.equal(read("add 50% deposit")?.depositPercent, 50);
    for (const s of ["add vat", "remove the vat", "add 50% deposit"]) {
      assert.equal(read(s)?.addLines, undefined, s);
      assert.equal(read(s)?.removeLine, undefined, s);
    }
  });

  it("reads an addition alongside the other things in the sentence", () => {
    const c = read("add SEO 100k due next friday");
    assert.deepEqual(c?.addLines, [{ description: "SEO", unitAmountKobo: 100_000_00 }]);
    assert.deepEqual(c?.dueDate, { y: 2026, m: 10, d: 2 });
  });

  it("hands anything it only half understood to the model", () => {
    /*
     * Every part or none. Half of "add SEO 100k and make it urgent" is an
     * item nobody asked for, priced at whatever the sentence ended with \u2014
     * and an invoice that is quietly wrong is worse than one more model call.
     */
    assert.equal(read("add SEO 100k and make it urgent"), null);
    assert.equal(read("add the photoshoot"), null, "named, but not priced");
  });
});

/**
 * Moving one payment without moving the invoice.
 *
 * "let the 50% deposit be due on Friday this week" came back as the draft,
 * unchanged, because every date in a payment plan was worked out from the
 * issue date and the document's due date \u2014 the first part was always "due
 * now" and there was nowhere for that sentence to land. A draft that returns
 * identical reads as the bot ignoring you.
 */
describe("a date for one part of the payment plan", () => {
  const today = { y: 2026, m: 9, d: 23 } as const;
  const read = (s: string) => readCorrection(s, today);

  it("reads which part, however it is named", () => {
    for (const [said, which] of [
      ["let the 50% deposit be due on Friday this week", "first"],
      ["the deposit is due friday", "first"],
      ["make the balance due 30 october", "last"],
      ["make the final payment due 1 november", "last"],
      ["part 2 due oct 15", 2],
      ["the second payment should be due next monday", 2],
    ] as const) {
      assert.equal(read(said)?.stageDue?.which, which, said);
    }
  });

  it("puts the date on the part and not on the invoice", () => {
    /*
     * The two rules both begin at the word "due", and the document rule
     * takes everything after it. Left in that order, this sentence moved the
     * whole invoice to Friday and said nothing about the deposit \u2014 wrong in
     * a way the summary would have shown as right.
     */
    const c = read("let the 50% deposit be due on Friday this week");
    assert.deepEqual(c?.stageDue?.date, { y: 2026, m: 9, d: 25 });
    assert.equal(c?.dueDate, undefined, "the invoice's own date must not move");
  });

  it("still reads a date for the whole document", () => {
    const c = read("due next friday");
    assert.deepEqual(c?.dueDate, { y: 2026, m: 10, d: 2 });
    assert.equal(c?.stageDue, undefined);
  });
});

/**
 * The one field on a draft that could not be corrected.
 *
 * "change the email to uakdan209@gmail.com" \u2014 a sentence with exactly one
 * possible meaning \u2014 came back as "I did not catch that", so a typo in an
 * address meant discarding the draft and writing the whole invoice again.
 */
describe("changing where the client's copy goes", () => {
  const today = { y: 2026, m: 9, d: 23 } as const;
  const read = (s: string) => readCorrection(s, today);

  it("takes an address however it is introduced", () => {
    for (const said of [
      "change the email to uakdan209@gmail.com",
      "email uakdan209@gmail.com",
      "the email is uakdan209@gmail.com",
      "email: UakDan209@Gmail.com",
      "client email should be uakdan209@gmail.com",
      // What people send when they have already been asked once.
      "uakdan209@gmail.com",
    ]) {
      assert.equal(read(said)?.clientEmail, "uakdan209@gmail.com", said);
    }
  });

  it("reads an address as an address, not as a person", () => {
    /*
     * "send it to X" is one of the phrases the client rule answers to, so
     * without this the draft came back addressed to a client called
     * "Daniel@studio.ng".
     */
    const c = read("send it to daniel@studio.ng");
    assert.equal(c?.clientEmail, "daniel@studio.ng");
    assert.equal(c?.clientName, undefined);
  });

  it("does not trip over the word people put on the end", () => {
    // "instead" broke the anchor, and a correction half understood is one
    // this reader refuses outright.
    assert.equal(read("use joshua@opay.com instead")?.clientEmail, "joshua@opay.com");
  });

  it("takes the address off when asked", () => {
    // Null is an instruction, not an absence: it means send no copy. A field
    // nobody mentioned is undefined.
    for (const said of ["no email", "remove the email"]) {
      assert.equal(read(said)?.clientEmail, null, said);
    }
    assert.equal(read("make it 400k")?.clientEmail, undefined);
  });
});

/**
 * Rewording a line, which used to delete it.
 *
 * "change the commercial for opay to commercial for Opay Nigeria" had no
 * home in the schema, so the model said it the only way it could: remove
 * that line, add a new one. The new one carried no price and was dropped for
 * being half an item. The removal was not. A \u20a62,500,000 line vanished off
 * the draft, the invoice fell to \u20a6215,000, and nothing anywhere said a line
 * had been deleted.
 */
describe("rewording a line that is already there", () => {
  const today = { y: 2026, m: 9, d: 23 } as const;
  const read = (s: string) => readCorrection(s, today);

  it("reads the two halves either side of \u201cto\u201d", () => {
    assert.deepEqual(read("change the commercial for opay to commercial for Opay Nigeria")?.renameLine, {
      match: "commercial for opay",
      to: "commercial for Opay Nigeria",
    });
    assert.deepEqual(read("rename the logo to logo design")?.renameLine, {
      match: "logo",
      to: "logo design",
    });
  });

  it("never takes a sentence a named field already owns", () => {
    /*
     * This rule is last for a reason: every one of these is "change X to Y"
     * and none of them is a rename. Run it any earlier and "change the
     * amount to 400k" renames a line to "400k" and leaves the price alone.
     */
    for (const [said, field] of [
      ["change the amount to 400k", "totalKobo"],
      ["change the client to Daniel", "clientName"],
      ["change the item to photography", "description"],
      ["change the email to a@b.com", "clientEmail"],
    ] as const) {
      const c = read(said)!;
      assert.ok(c[field] !== undefined, said);
      assert.equal(c.renameLine, undefined, said);
    }
  });

  it("is not a removal", () => {
    // The whole point. A rename keeps the line and its money.
    const c = read("change revisions to extra revisions")!;
    assert.equal(c.removeLine, undefined);
    assert.equal(c.addLines, undefined);
  });
});
