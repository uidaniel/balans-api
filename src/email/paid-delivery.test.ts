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

describe("a paid invoice", () => {
  it("is known to be paid, and carries no stamp", () => {
    // The stamp is gone: its `.paid` rule also reached the "Paid in full"
    // headline three layouts mark `class="due paid"`, and rotated it off the
    // page. The headline says it, once (templates.test.ts).
    assert.equal(isPaid(doc()), true);
    assert.doesNotMatch(sheet(doc(), {}, { css: "", body: "" }), />PAID</);
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
    assert.match(source, /cid: "receipt-banner"/);
    assert.ok(!/<img src="https?:/.test(source));
  });

  it("has both pictures on disk, at twice the width they are shown at", () => {
    for (const file of ["paid-banner.png", "receipt-banner.png"]) {
      const png = readFileSync(new URL(`../../assets/email/${file}`, import.meta.url));
      assert.equal(png.readUInt32BE(16), 1120, file);
      assert.equal(png.readUInt32BE(20), 448, file);
    }
  });

  it("never shows the client the freelancer's half of the message", () => {
    /*
     * Reported from a real inbox. Both emails carried the same banner, and
     * it reads "Dem don balans you" — the product's one piece of Nigerian
     * English, addressed to the person who has just been paid. It went to
     * the person who had just paid.
     *
     * That is the wrong half of the voice pointed at the wrong reader, on
     * the message a client is most likely to keep, forward to their accounts
     * department, or open somewhere the idiom means nothing at all.
     */
    const client = source.slice(
      source.indexOf("export async function emailPaidToClient"),
      source.indexOf("export async function emailPaidToUser"),
    );
    const user = source.slice(source.indexOf("export async function emailPaidToUser"));

    assert.ok(!client.includes("PAID_BANNER"), "the client is getting the freelancer's banner");
    assert.ok(!/balans you/i.test(client), "the phrase reached the client's copy");
    assert.match(client, /images: \[RECEIPT_BANNER\]/);

    // And the freelancer keeps it: it is their moment, and only theirs.
    assert.match(user, /images: \[PAID_BANNER\]/);
    assert.match(user, /Dem don balans you/);
    assert.ok(!user.includes("RECEIPT_BANNER"));
  });

  it("writes to the client formally, for somebody who may be abroad", () => {
    /*
     * This one is from a business to its client. It has to be understood by
     * a stranger who has never heard of us, may not read English as a first
     * language, and will file it — so plain formal English, and none of the
     * product's own voice.
     */
    const client = source.slice(
      source.indexOf("export async function emailPaidToClient"),
      source.indexOf("export async function emailPaidToUser"),
    );

    assert.match(client, /Dear \$\{esc\(d\.client_name\)\},/);
    assert.match(client, /has been received in full/);
    assert.match(client, /Thank you for your business/);
    // "Receipt" is the word somebody searches their inbox for in March.
    assert.match(client, /subject: `Receipt — /);
  });
});
