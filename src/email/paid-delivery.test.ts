/**
 * What a payment sends, and what it must never do.
 *
 * These assert the rules rather than the wording: which documents get stamped,
 * that both sides are told, that nothing here can throw, and that the emails
 * come last. The money has already moved by the time any of this runs, so
 * every failure mode has to cost paperwork and never a payment.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { isPaid, sheet } from "../pdf/kit.ts";
import type { DocumentData } from "../pdf/template.ts";

const doc = (over: Partial<DocumentData> = {}): DocumentData => ({
  variant: "invoice",
  number: 2,
  ref: "BL-0002",
  businessName: "Studio",
  businessEmail: null,
  businessAddress: null,
  businessTin: null,
  logoDataUri: null,
  clientName: "Daniel Uwak",
  clientEmail: null,
  lines: [{ description: "Logo", qty: 1, unitAmountKobo: 50_000_00, amountKobo: 50_000_00 }],
  subtotalKobo: 50_000_00,
  vatKobo: 0,
  vatPercent: null,
  totalKobo: 50_000_00,
  amountPaidKobo: 50_000_00,
  issueDate: { y: 2026, m: 9, d: 23 },
  dueDate: { y: 2026, m: 9, d: 30 },
  notes: null,
  publicUrl: null,
  legalLines: ["Issued by Studio", "Payments handled by Monnify"],
  showMadeWith: false,
  ...over,
});

describe("the PAID stamp", () => {
  it("goes on an invoice that is settled in full", () => {
    assert.equal(isPaid(doc()), true);
    assert.match(sheet(doc(), {}, { css: "", body: "" }), /class="paid">PAID</);
  });

  it("stays off a deposit", () => {
    /*
     * The one that would be a lie on a document somebody files. Half of an
     * invoice is not a paid invoice, and the stamp is the first thing an
     * accounts department reads.
     */
    assert.equal(isPaid(doc({ amountPaidKobo: 20_000_00 })), false);
    assert.equal(isPaid(doc({ amountPaidKobo: 0 })), false);
  });

  it("stays off the documents it would say nothing on", () => {
    // A receipt already IS proof of payment; a quote has nothing to pay yet;
    // a sample is a demonstration with nobody's money in it.
    assert.equal(isPaid(doc({ variant: "receipt" })), false);
    assert.equal(isPaid(doc({ variant: "quote" })), false);
    assert.equal(isPaid(doc({ variant: "sample" })), false);
  });

  it("stays off an empty document", () => {
    // Nothing owed on nothing is not paid, it is empty — and `owed <= 0`
    // would otherwise stamp it.
    assert.equal(isPaid(doc({ totalKobo: 0, amountPaidKobo: 0 })), false);
  });

  it("sits behind the figures rather than over them", () => {
    /*
     * An invoice is a record somebody's accountant reads. A stamp that
     * obscures an amount turns a paid invoice into a query, which is the
     * opposite of what it is for.
     */
    const css = sheet(doc(), {}, { css: "", body: "" });
    assert.match(css, /\.paid\{[^}]*position:absolute/);
    assert.match(css, /\.paid\{[^}]*opacity:\.17/);
    assert.match(css, /\.paid\{[^}]*pointer-events:none/);
  });
});

describe("the emails a payment sends", () => {
  const source = readFileSync(new URL("./paid-delivery.ts", import.meta.url), "utf8");
  const notify = readFileSync(new URL("../payments/notify.ts", import.meta.url), "utf8");

  it("sends both sides their copy, and only when it is settled", () => {
    assert.match(notify, /emailPaidToClient\(n\.documentId, log\)/);
    assert.match(notify, /emailPaidToUser\(n\.documentId, log\)/);
    // A deposit is not a paid invoice.
    assert.match(notify, /if \(n\.documentId && n\.fullyPaid\)/);
  });

  it("puts the chat first and the paperwork after it", () => {
    /*
     * Rendering two PDFs and talking to a mail provider must not stand
     * between a payment and somebody hearing about it. The chat is where
     * this product lives.
     */
    assert.ok(
      notify.indexOf("const outcome = await send(") < notify.indexOf("emailPaidToClient("),
      "the WhatsApp message is sent first",
    );
    assert.match(notify, /void emailPaidToClient/, "and the emails are not awaited");
  });

  it("cannot throw, because the money has already moved", () => {
    // Both functions are wrapped, and both return rather than rethrow.
    assert.equal(source.match(/} catch \(e\) \{/g)?.length, 2);
    assert.ok(!/throw /.test(source), "nothing here throws");
  });

  it("attaches the invoice and the receipt, not one or the other", () => {
    // They answer different questions: what the money was for, and that it
    // was paid. An accounts department asks for either.
    assert.match(source, /renderDocumentPdf\(documentId, log\)/);
    assert.match(source, /receiptForDocument\(documentId, log\)/);
    // And the sentence about attachments changes when the receipt is missing,
    // so the email never promises a file that is not there.
    assert.match(source, /receipt\n\s*\? "Your receipt and the paid invoice are attached/);
  });

  it("only claims a receipt when a payment actually succeeded", () => {
    assert.match(source, /status = 'success'/);
  });

  it("sends the client's copy whatever plan the freelancer is on", () => {
    /*
     * Client delivery of an invoice is a Pro feature (F21). This is not
     * that: it is proof of money that has already changed hands, and a
     * client who paid is owed it whoever they paid.
     */
    assert.ok(!/requirePro|plan !== "pro"/.test(source));
  });

  it("carries its picture with it rather than linking to one", () => {
    // Mail clients block remote images by default, and the one message this
    // product exists to send must not arrive as a broken-image icon.
    assert.match(source, /cid: "paid-banner"/);
    assert.match(source, /images: \[PAID_BANNER\]/);
    assert.ok(!/<img src="https?:/.test(source));
  });

  it("has the picture on disk, at twice the width it is shown at", () => {
    const png = readFileSync(new URL("../../assets/email/paid-banner.png", import.meta.url));
    assert.equal(png.readUInt32BE(16), 1120);
    assert.equal(png.readUInt32BE(20), 448);
  });
});
