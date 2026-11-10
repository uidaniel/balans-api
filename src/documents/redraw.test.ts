/** A sent invoice drawn again in the current design (9 November 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { designAsked, redrawAsked, step } from "../conversation/machine.ts";
import { redrawCaption } from "./redraw.ts";

const say = (text: string) => step("idle", {}, { text, today: { y: 2026, m: 11, d: 9 } } as never, "5.2");

describe("asking for a redraw", () => {
  it("hears it with a number and without one", () => {
    assert.deepEqual(redrawAsked("redraw invoice 1"), { number: 1 });
    assert.deepEqual(redrawAsked("Redo the pdf for invoice #12"), { number: 12 });
    assert.deepEqual(redrawAsked("Can you redo the pdf with my chosen design?"), { number: null });
    assert.deepEqual(redrawAsked("use the new design on invoice 3"), { number: 3 });
    assert.equal(redrawAsked("resend invoice 1"), null);
  });

  it("is the button under the offer", () => {
    assert.deepEqual(say("redraw invoice 1").effects, [{ type: "redraw_document", number: 1 }]);
  });
});

describe("a design asked for in words", () => {
  it("names one, or asks for the picker", () => {
    assert.deepEqual(designAsked("Let's use Slip design"), { name: "slip" });
    assert.deepEqual(designAsked("Can you use another template. I don't like this template"), { pick: true });
    assert.deepEqual(designAsked("I don't like this design"), { pick: true });
    assert.equal(designAsked("Invoice Tunde 20k for logo design"), null);
  });

  it("sets it, or opens the picker", () => {
    assert.deepEqual(say("Let's use Slip design").effects, [{ type: "set_design", name: "slip" }]);
    assert.deepEqual(say("use another template").effects, [{ type: "show_designs" }]);
    // "my chosen design" with a redo is a redraw, not a new design.
    assert.deepEqual(say("Can you redo the pdf with my chosen design?").effects, [{ type: "redraw_document", number: null }]);
  });
});

describe("what comes with the redrawn PDF", () => {
  it("says nothing about the money changed, and that the link has it", () => {
    const c = redrawCaption({ number: 1, type: "invoice", clientName: "ShiningStar" });
    assert.match(c, /Invoice #1, in your current design/);
    assert.match(c, /Same number, amounts and link\. ShiningStar's link shows this one now/);
  });
});

describe("a design word, not any word", () => {
  it("leaves an invoice that mentions a design alone", () => {
    assert.equal(designAsked("I want logo design for Tunde 50k"), null);
    assert.deepEqual(designAsked("switch to Glare design"), { name: "glare" });
  });
});
