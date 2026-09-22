/**
 * A payment request has no document, and that is what it is for.
 *
 * F8 calls it "a lightweight payable with no PDF". The payment page has
 * always honoured that — it offers no download for one, because "there is
 * nothing itemised to render, and offering one implies there is."
 *
 * Nothing else did. The send path rendered one and WhatsApp attached it, the
 * /pdf route would serve it to anybody who typed the URL, and the email to
 * the client attached it and said so. So the product refused to hand over a
 * file it had already sent twice, and the file itself was a one-line page
 * carrying a number and a link — the paperwork a request exists to skip.
 *
 * The rule now lives in four places, which is why it is written down here:
 * an invoice and a quote arrive as a document to forward, a request arrives
 * as a message with a link in it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { closingLine } from "../email/client-delivery.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("a payment request carries no PDF", () => {
  it("is not rendered when the document is sent", () => {
    const handle = read("../conversation/handle.ts");
    assert.match(
      handle,
      /confirmed\.type === "payment_request"\s*\?\s*null\s*:\s*await renderDocumentPdf/,
      "the send path should skip the render for a request",
    );
  });

  it("is refused by the download route", () => {
    // The page never offers this link for a request. Typing it by hand should
    // not produce a file the rest of the product says does not exist.
    const route = read("../http/routes/public.ts");
    const pdfRoute = route.slice(route.indexOf('"/i/:token/pdf"'));
    const guard = pdfRoute.indexOf('doc.type === "payment_request"');
    const render = pdfRoute.indexOf("renderDocumentPdf");

    assert.ok(guard > -1, "the route should refuse a request outright");
    assert.ok(guard < render, "and refuse it before rendering anything");
  });

  it("is not attached to the client's email", () => {
    const email = read("../email/client-delivery.ts");
    assert.match(
      email,
      /d\.type === "payment_request"\s*\?\s*null\s*:\s*await renderDocumentPdf/,
      "no attachment for a request",
    );
  });

  it("is not promised in the client's email either", () => {
    // Claiming an attachment that is not there is worse than not sending one:
    // the client goes looking for a file, does not find it, and asks the user
    // about it. Asked of the sentence itself rather than of the source text.
    const request = closingLine("payment_request", "Invoice", "https://balans.ng/i/abc");

    assert.doesNotMatch(request, /attach/i, "a request's email must not mention an attachment");
    assert.match(request, /https:\/\/balans\.ng\/i\/abc/, "but it still says where to find it");
    assert.match(request, /^[A-Z]/, "and reads as a sentence");
  });

  it("is still promised for an invoice and a quote", () => {
    // The sentence is only worth testing because the other two keep theirs.
    for (const [type, label] of [
      ["invoice", "Invoice"],
      ["quote", "Quote"],
    ] as const) {
      const line = closingLine(type, label, "https://balans.ng/i/abc");
      assert.match(line, /is attached/, `${type} still arrives with its document`);
      assert.match(line, new RegExp(label.toLowerCase()), "and says which one");
    }
  });

  it("still points somewhere when there is no link", () => {
    // public_token is nullable, and "see it at null." is not a sentence.
    for (const type of ["payment_request", "invoice"]) {
      assert.match(closingLine(type, "Invoice", null), /the link above/);
    }
  });

  it("still renders one for an invoice and a quote", () => {
    // The distinction only means something if the other two keep theirs.
    const handle = read("../conversation/handle.ts");
    assert.match(handle, /await renderDocumentPdf\(confirmed\.id, log\)/);

    const email = read("../email/client-delivery.ts");
    assert.match(email, /await renderDocumentPdf\(documentId, log\)/);
  });
});
