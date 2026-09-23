/**
 * Turning a submitted form into line items.
 *
 * The form used to hold one description and one amount, so an invoice for
 * three things had to be written as a sentence or squashed into one line —
 * "logo, website and business cards" at a single price, which is neither what
 * was being billed nor what the client wants to read.
 *
 * Five slots now arrive, four of them optional and hidden behind checkboxes,
 * so the input is sparse and full of gaps. Most of what is checked here is
 * money: what happens to a slot somebody half filled in, and whether anything
 * can quietly disappear between the form closing and the draft appearing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { linesFromForm, totalOfLines } from "./form-lines.ts";

const form = (over: Record<string, string> = {}): Record<string, string> => ({
  client_name: "Tunde",
  description: "Logo design",
  amount: "50000",
  ...over,
});

describe("one item, which is most invoices", () => {
  it("reads it", () => {
    const out = linesFromForm(form());
    assert.ok(out.ok);
    assert.deepEqual(out.lines, [{ description: "Logo design", qty: 1, unitAmountKobo: 50_000_00 }]);
  });

  it("ignores the four empty slots behind it", () => {
    // They are in the JSON whether or not anybody ticked them, so they arrive
    // as empty strings on every single submission.
    const out = linesFromForm(
      form({
        item_two_description: "",
        item_two_amount: "",
        item_three_description: "",
        item_three_amount: "",
        item_four_description: "",
        item_four_amount: "",
        item_five_description: "",
        item_five_amount: "",
      }),
    );
    assert.ok(out.ok);
    assert.equal(out.lines.length, 1);
  });

  it("ignores a number input somebody opened and left at zero", () => {
    const out = linesFromForm(form({ item_two_description: "", item_two_amount: "0" }));
    assert.ok(out.ok);
    assert.equal(out.lines.length, 1);
  });
});

describe("several items", () => {
  const filled = form({
    item_two_description: "Website",
    item_two_amount: "250000",
    item_three_description: "Business cards",
    item_three_amount: "10000",
  });

  it("keeps them in the order they were filled in", () => {
    const out = linesFromForm(filled);
    assert.ok(out.ok);
    assert.deepEqual(
      out.lines.map((l) => l.description),
      ["Logo design", "Website", "Business cards"],
    );
  });

  it("gives each one its own amount", () => {
    const out = linesFromForm(filled);
    assert.ok(out.ok);
    assert.deepEqual(
      out.lines.map((l) => l.unitAmountKobo),
      [50_000_00, 250_000_00, 10_000_00],
    );
  });

  it("adds up to what was typed, to the kobo", () => {
    const out = linesFromForm(filled);
    assert.ok(out.ok);
    assert.equal(totalOfLines(out.lines), 310_000_00);
  });

  it("closes the gap when a middle slot is left empty", () => {
    /*
     * Somebody can tick three boxes, fill the first and third and leave the
     * second alone. The invoice should have two lines, not a blank one in
     * the middle.
     */
    const out = linesFromForm(
      form({
        item_two_description: "",
        item_two_amount: "",
        item_three_description: "Business cards",
        item_three_amount: "10000",
      }),
    );
    assert.ok(out.ok);
    assert.deepEqual(
      out.lines.map((l) => l.description),
      ["Logo design", "Business cards"],
    );
  });

  it("takes all five", () => {
    const out = linesFromForm(
      form({
        item_two_description: "b",
        item_two_amount: "2000",
        item_three_description: "c",
        item_three_amount: "3000",
        item_four_description: "d",
        item_four_amount: "4000",
        item_five_description: "e",
        item_five_amount: "5000",
      }),
    );
    assert.ok(out.ok);
    assert.equal(out.lines.length, 5);
  });
});

describe("an item that is only half there", () => {
  /*
   * The case that decides whether this is safe.
   *
   * Somebody ticks "Add another item", types "Business cards", and taps Next
   * without an amount. Dropping it quietly sends an invoice short by whatever
   * those cards cost, with nothing on screen to say so. Their own words are
   * the evidence they meant to bill for it.
   */
  it("refuses words with no money rather than dropping them", () => {
    const out = linesFromForm(form({ item_two_description: "Business cards", item_two_amount: "" }));
    assert.equal(out.ok, false);
    assert.ok(!out.ok && out.reason === "half");
    assert.ok(!out.ok && out.reason === "half" && out.hasDescription);
  });

  it("says which slot, counting the way the screen does", () => {
    const out = linesFromForm(form({ item_three_description: "Business cards" }));
    assert.ok(!out.ok && out.reason === "half");
    assert.equal(!out.ok && out.reason === "half" && out.position, 3);
  });

  it("refuses money with no words too", () => {
    // A line reading "—  ₦10,000" is not something to send a client.
    const out = linesFromForm(form({ item_two_description: "", item_two_amount: "10000" }));
    assert.ok(!out.ok && out.reason === "half");
    assert.equal(!out.ok && out.reason === "half" && out.hasDescription, false);
  });

  it("refuses an amount it cannot read", () => {
    // The field is a number input, so this should not happen — which is
    // exactly why it must not become a silently dropped line if it does.
    const out = linesFromForm(form({ item_two_description: "Website", item_two_amount: "a lot" }));
    assert.ok(!out.ok && out.reason === "half");
  });

  it("catches the first slot as well as the rest", () => {
    const out = linesFromForm({ client_name: "Tunde", description: "Logo design", amount: "" });
    assert.ok(!out.ok && out.reason === "half");
    assert.equal(!out.ok && out.reason === "half" && out.position, 1);
  });
});

describe("a form with nothing billable on it", () => {
  it("says so rather than making an empty invoice", () => {
    const out = linesFromForm({ client_name: "Tunde" });
    assert.ok(!out.ok && out.reason === "nothing");
  });

  it("treats whitespace as empty", () => {
    const out = linesFromForm({ client_name: "Tunde", description: "   ", amount: "  " });
    assert.ok(!out.ok && out.reason === "nothing");
  });
});

describe("amounts", () => {
  it("takes the shorthand, since the field is not always a number pad", () => {
    const out = linesFromForm(form({ amount: "50k" }));
    assert.ok(out.ok);
    assert.equal(out.lines[0]!.unitAmountKobo, 50_000_00);
  });

  it("takes a number input's own formatting", () => {
    for (const raw of ["50000", "50,000", "₦50000", " 50000 "]) {
      const out = linesFromForm(form({ amount: raw }));
      assert.ok(out.ok, `${raw} was refused`);
      assert.equal(out.lines[0]!.unitAmountKobo, 50_000_00, raw);
    }
  });

  it("keeps kobo rather than rounding somebody's price", () => {
    const out = linesFromForm(form({ amount: "1500.50" }));
    assert.ok(out.ok);
    assert.equal(out.lines[0]!.unitAmountKobo, 150_050);
  });
});
