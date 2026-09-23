/**
 * A quote, from sent to invoiced, and the three ways it was lying.
 *
 * Each piece of this worked. The quote was created, stored with its payment
 * plan, refused payment correctly, and converted into an invoice that copied
 * the plan across and reset it. Every one of those has a test and they all
 * passed. What nobody had done was follow a quote all the way through and
 * read what the client sees at each step.
 *
 * Three things were wrong, in rising order of seriousness:
 *
 * The plan was tagged "DUE NOW" and "LATER" on a quote, a few centimetres
 * above "This is a quote, not an invoice." Nothing is due on a quote.
 *
 * Every quote said "Reply to accept it" whatever state it was in, because
 * `payable` asked whether it was a quote before it asked anything about its
 * status. So an expired quote invited acceptance of a lapsed price, and a
 * converted one invited acceptance of work already invoiced — which is how a
 * client accepts twice and a freelancer bills twice.
 *
 * And converting sent nothing. The invoice row was written with status 'sent'
 * and sent_at set, and the client never received it: no document, no link, no
 * email. The overdue sweep then started counting down on somebody who had
 * never been billed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { renderDocument } from "./page.ts";
import { payable, type PublicDocument, type PublicStatus } from "./public.ts";
import { convertedForward } from "./summary.ts";

const N = (naira: number) => naira * 100;
const today = { y: 2026, m: 9, d: 23 };

const PARTS = [
  { id: "p1", position: 0, label: "Part 1 of 2", amountKobo: N(100_000), status: "payable" as const, paidAt: null },
  { id: "p2", position: 1, label: "Part 2 of 2", amountKobo: N(100_000), status: "pending" as const, paidAt: null },
];

const doc = (over: Partial<PublicDocument>): PublicDocument =>
  ({
    id: "d",
    userId: "u",
    type: "quote",
    number: 1,
    status: "sent",
    businessName: "Pysavant Codes",
    clientName: "danny@example.com",
    lines: [{ description: "Photography", qty: 1, unitAmountKobo: N(200_000), amountKobo: N(200_000) }],
    subtotalKobo: N(200_000),
    vatKobo: 0,
    totalKobo: N(200_000),
    amountPaidKobo: 0,
    passFeesToClient: false,
    dueDate: null,
    issueDate: today,
    notes: null,
    subAccountCode: "SUB",
    plan: "free",
    parts: PARTS,
    ...over,
  }) as PublicDocument;

const text = (d: PublicDocument) =>
  renderDocument(d, today, { token: "tok" })
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("what a quote's payment plan says", () => {
  it("shows the figures without pretending anything is due", () => {
    const page = text(doc({}));
    assert.match(page, /Payment plan/, "the rows are named, since they have no tags");
    assert.match(page, /Part 1 of 2 ₦100,000/);
    assert.doesNotMatch(page, /Due now/, "nothing is due on an offer");
    assert.doesNotMatch(page, /Later/);
  });

  it("still tags them on an invoice, where they mean something", () => {
    const page = text(doc({ type: "invoice" }));
    assert.match(page, /Due now/);
    assert.match(page, /Later/);
  });
});

describe("what a quote says about itself, in every state", () => {
  const cases: [PublicStatus, RegExp, RegExp][] = [
    ["sent", /Reply to Pysavant Codes to accept it/, /expired|withdrawn|already/i],
    ["viewed", /Reply to Pysavant Codes to accept it/, /expired|withdrawn|already/i],
    ["expired", /This quote has expired/, /to accept it/],
    ["cancelled", /withdrawn by Pysavant Codes/, /to accept it/],
    ["converted", /accepted and invoiced/, /to accept it/],
    ["accepted", /accepted and invoiced/, /to accept it/],
  ];

  for (const [status, says, never] of cases) {
    it(`a ${status} quote says the right thing`, () => {
      const page = text(doc({ status }));
      assert.match(page, says);
      assert.doesNotMatch(page, never, `a ${status} quote must not say this`);
    });
  }

  it("never invites acceptance of a quote that cannot be accepted", () => {
    // The one that matters: accepting twice means being billed twice.
    for (const status of ["expired", "cancelled", "converted", "accepted"] as PublicStatus[]) {
      const page = text(doc({ status }));
      assert.doesNotMatch(page, /accept it/, `${status} still invited acceptance`);
      assert.doesNotMatch(page, /If you accept this quote/, `${status} in the small print`);
    }
  });

  it("keeps the disclosure whatever state it is in", () => {
    // Section 12. True of every document, so it survives every branch.
    for (const status of ["sent", "expired", "cancelled", "converted"] as PublicStatus[]) {
      assert.match(text(doc({ status })), /not a bank and does not hold your money/);
    }
  });

  it("is never payable, whatever the state", () => {
    for (const status of ["sent", "viewed", "expired", "cancelled", "converted"] as PublicStatus[]) {
      assert.equal(payable(doc({ status })).ok, false);
    }
  });
});

describe("converting it", () => {
  it("copies the plan across and reopens the first part", () => {
    // Read from the SQL, because this is the one step with no seam to call:
    // the reset is done by the insert itself.
    const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    const convert = actions.slice(actions.indexOf("export async function convertQuote"));

    assert.match(convert, /INSERT INTO payment_parts/, "the plan comes with the work");
    assert.match(
      convert,
      /CASE WHEN position = 0 THEN 'payable' ELSE 'pending'/,
      "and starts again, since a quote was never payable",
    );
  });

  it("actually sends the invoice it just created", () => {
    /*
     * The invoice is written with status 'sent' and sent_at set. If nothing
     * goes out, the product believes it billed somebody it never contacted,
     * and the overdue sweep starts chasing them for it.
     */
    const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");
    const branch = handle.slice(handle.indexOf('effect.intent === "convert_quote"'));
    const convert = branch.slice(0, branch.indexOf("\n          }\n") + 12);

    assert.match(convert, /emailDocumentToClient/, "the client's inbox");
    assert.match(convert, /renderDocumentPdf/, "the document");
    assert.match(convert, /sendDocument\(/, "and a message to forward");
    assert.match(convert, /convertedForward\(/, "written for the client, not the sender");
  });

  it("falls back to the link when the PDF cannot be made", () => {
    const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");
    const branch = handle.slice(handle.indexOf('effect.intent === "convert_quote"'));
    assert.match(branch.slice(0, 3000), /extra\.push\(forward\)/, "the link is the part that matters");
  });
});

describe("the message the client gets after conversion", () => {
  const forward = convertedForward(
    { number: 2, clientName: "Danny", totalKobo: N(200_000), dueDate: { y: 2026, m: 10, d: 7 } },
    PARTS,
    "https://payment.balans.ng/i/tok",
    today,
  );

  it("is written to be forwarded, with nothing addressed to the sender", () => {
    assert.doesNotMatch(forward, /Reply|your invoice|you sent/i);
    assert.match(forward, /Click the link to pay/);
    assert.match(forward, /https:\/\/payment\.balans\.ng\/i\/tok/);
  });

  it("carries the plan the client agreed to", () => {
    assert.match(forward, /Part 1 of 2 — ₦100,000 \(due now\)/);
    assert.match(forward, /Part 2 of 2 — ₦100,000/);
  });

  it("says what is owed and when", () => {
    assert.match(forward, /₦200,000/);
    assert.match(forward, /Due/);
  });
});
