/**
 * Who a document is for, and getting it to them.
 *
 * Three fixes from one morning of screenshots on 26 September 2026: "hi"
 * became a client called Hi with no way to rename them, the form's email
 * lost to an older address, and the client could only be reached by the
 * freelancer forwarding the invoice by hand.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { step, CHANGE_NAME, type Context } from "./machine.ts";
import { readCorrection } from "../parser/corrections.ts";
import { displayPhone } from "../documents/summary.ts";
import { amountFor, clientMessage, firstName } from "../documents/client-whatsapp.ts";

const V = "2026-09-draft-1";
const NOW = { y: 2026, m: 9, d: 26 };
const say = (state: Parameters<typeof step>[0], ctx: Context, text: string) =>
  step(state, ctx, { text, today: NOW }, V);

const NAMED: Context = { doc: { type: "invoice", clientName: "Hi", lines: [] } };

describe("a client name that came out wrong", () => {
  it("is never a greeting", () => {
    const out = say("awaiting_field:client_name", { doc: { type: "invoice", lines: [] } }, "hi");
    assert.equal(out.next, "awaiting_field:client_name");
    assert.equal(out.context.doc?.clientName, undefined);
  });

  it("offers a button to change it, under the amount question", () => {
    const out = say("awaiting_field:client_name", { doc: { type: "invoice", lines: [] } }, "Tunde");
    assert.equal(out.next, "awaiting_field:amount");
    assert.deepEqual(out.buttons, [CHANGE_NAME]);
    // And still after an amount it could not read.
    assert.deepEqual(say("awaiting_field:amount", NAMED, "lots").buttons, [CHANGE_NAME]);
  });

  it("asks again when the button is tapped", () => {
    const out = say("awaiting_field:amount", NAMED, CHANGE_NAME.id);
    assert.equal(out.next, "awaiting_field:client_name");
    assert.equal(out.context.doc?.clientName, undefined);
    assert.match(out.replies.join("\n"), /who is this for/i);
  });

  it("takes the new name in a sentence, and goes back to the amount", () => {
    for (const text of ["change the name to Daniel", "the name is daniel", "it's for Daniel", "rename it to Daniel"]) {
      const out = say("awaiting_field:amount", NAMED, text);
      assert.equal(out.context.doc?.clientName, "Daniel", text);
      assert.equal(out.next, "awaiting_field:amount", text);
      assert.match(out.replies.join("\n"), /How much is Daniel paying/, text);
    }
  });
});

describe("the client's WhatsApp number", () => {
  it("is read off a correction, before its digits can be taken for a price", () => {
    assert.deepEqual(readCorrection("their number is 0803 123 4567", NOW), { clientPhone: "0803 123 4567" });
    assert.deepEqual(readCorrection("send it to 08031234567", NOW), { clientPhone: "08031234567" });
    assert.deepEqual(readCorrection("no whatsapp", NOW), { clientPhone: null });
    // A name and an email are still what they were.
    assert.deepEqual(readCorrection("send it to tunde@x.com", NOW), { clientEmail: "tunde@x.com" });
  });

  it("lands on the draft as international digits", () => {
    const text = "their number is 0803 123 4567";
    // The caller reads the correction, as handle.ts does, and hands it in.
    const out = step(
      "awaiting_confirm",
      { doc: { type: "invoice", clientName: "Tunde", lines: [{ description: "logo", qty: 1, unitAmountKobo: 20_000_00 }] }, draftId: "d" },
      { text, today: NOW, correction: readCorrection(text, NOW) },
      V,
    );
    assert.equal(out.context.doc?.clientPhone, "2348031234567");
  });

  it("is shown the way it is written here", () => {
    assert.equal(displayPhone("2348031234567"), "0803 123 4567");
    assert.equal(displayPhone("447700900123"), "+447700900123");
  });
});

describe("the message the client gets", () => {
  it("greets them by first name and says who it is from", () => {
    assert.equal(firstName("Tunde Olamide"), "Tunde");
    const m = clientMessage({ type: "invoice", number: 8, client_name: "Tunde Olamide", business_name: "Kemi Studio", amount: "₦200,000" });
    assert.equal(m.template, "client_invoice");
    assert.deepEqual(m.params, ["Tunde", "Kemi Studio", "Invoice 8", "₦200,000"]);
  });

  it("says what kind of document it is", () => {
    const q = clientMessage({ type: "quote", number: 3, client_name: "Ada", business_name: "Kemi", amount: "₦1" });
    assert.equal(q.template, "client_quote");
    assert.equal(q.params[3], "Quote 3");
    const r = clientMessage({ type: "payment_request", number: 4, client_name: "Ada", business_name: "Kemi", amount: "₦1" });
    assert.equal(r.params[2], "a payment request");
  });

  it("states a dollar invoice in dollars, VAT and all", () => {
    // $650 before 7.5% VAT is $698.75, whatever the naira came to.
    const a = amountFor({ total_kobo: 0, subtotal_kobo: 1000, vat_kobo: 75, currency: "USD", original_amount_minor: 65000 });
    assert.equal(a, "$698.75");
    assert.equal(
      amountFor({ total_kobo: 200_000_00, subtotal_kobo: 0, vat_kobo: 0, currency: "NGN", original_amount_minor: null }),
      "₦200,000",
    );
  });
});
