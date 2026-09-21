/**
 * The fill-in form.
 *
 * One message out, one back, and the whole document arrives at once. The
 * alternative was four questions, each of which is a real charge from October
 * 2026 — four of them cost more than the minimum fee on the invoice they are
 * collecting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Civil } from "../../core/dates.ts";
import { looksLikeTemplate, readFields, readTemplate } from "./template.ts";

const TODAY: Civil = { y: 2026, m: 9, d: 23 };
const N = (naira: number) => naira * 100;

describe("reading a filled-in form", () => {
  it("takes every field", () => {
    const out = readTemplate(
      "Client: Daniel Uwak\nAmount: 2500\nFor: Brand design\nDue: Friday",
      TODAY,
    );
    assert.ok(out);
    assert.equal(out.clientName, "Daniel Uwak");
    assert.equal(out.totalKobo, N(2_500));
    assert.equal(out.lineItems[0]?.description, "Brand design");
    assert.deepEqual(out.dueDate, { y: 2026, m: 9, d: 25 });
    assert.equal(out.source, "pattern", "a form must never cost a model call");
  });

  it("works with only the two fields that are required", () => {
    const out = readTemplate("Client: Tunde\nAmount: 20k", TODAY);
    assert.ok(out);
    assert.equal(out.clientName, "Tunde");
    assert.equal(out.totalKobo, N(20_000));
    // A description may be listed as missing, and that is fine: F6 defaults it
    // to "Services". Only these two block a draft.
    assert.ok(!out.missing.includes("client_name"));
    assert.ok(!out.missing.includes("amount"));
  });

  it("copes with the labels people actually use", () => {
    const variants = [
      "Client name: Tunde\nTotal: 20k",
      "Customer: Tunde\nPrice: 20k",
      "Name: Tunde\nHow much: 20k",
      "Bill to: Tunde\nAmount: 20k",
    ];
    for (const v of variants) {
      const out = readTemplate(v, TODAY);
      assert.ok(out, v);
      assert.equal(out.clientName, "Tunde", v);
      assert.equal(out.totalKobo, N(20_000), v);
    }
  });

  it("copes with a dash instead of a colon", () => {
    const out = readTemplate("Client - Tunde\nAmount - 20k", TODAY);
    assert.equal(out?.clientName, "Tunde");
  });

  it("ignores lines left blank", () => {
    // Somebody sends the form back having filled in half of it.
    const out = readTemplate("Client: Tunde\nAmount: 20k\nFor:\nDue:", TODAY);
    assert.ok(out);
    assert.equal(out.clientName, "Tunde");
    assert.deepEqual(out.dueDate, null);
  });

  it("keeps the first answer when the blank form is pasted underneath", () => {
    const out = readTemplate(
      "Client: Tunde\nAmount: 20k\n\nClient:\nAmount:\nFor:",
      TODAY,
    );
    assert.equal(out?.clientName, "Tunde");
    assert.equal(out?.totalKobo, N(20_000));
  });

  it("records an amount it cannot read rather than inventing one", () => {
    // "500$" is what somebody typed when the bot asked "how much?".
    const out = readTemplate("Client: Tunde\nAmount: 500$", TODAY);
    assert.ok(out);
    assert.equal(out.totalKobo, null);
    assert.ok(out.missing.includes("amount"));
  });
});

describe("what is not a form", () => {
  it("leaves a sentence with a colon alone", () => {
    // Treating this as a form would hijack ordinary messages.
    for (const text of ["Note: pay by Friday", "hello: there", "Client: Tunde"]) {
      assert.equal(readTemplate(text, TODAY), null, text);
    }
  });

  it("needs a client or an amount, whatever else it has", () => {
    // F6 requires those two. A form with only the trimmings is not a document.
    assert.equal(readTemplate("For: logo design\nDue: Friday", TODAY), null);
  });

  it("ignores labels it does not know", () => {
    const fields = readFields("Colour: blue\nSize: large");
    assert.deepEqual(fields, {});
    assert.equal(looksLikeTemplate("Colour: blue\nSize: large"), false);
  });

  it("recognises a real form", () => {
    assert.equal(looksLikeTemplate("Client: Tunde\nAmount: 20k"), true);
  });
});
