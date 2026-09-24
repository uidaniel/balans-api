/**
 * The panel somebody reads while they are moving money.
 *
 * Two things here are load-bearing and neither was covered by a test.
 *
 * The amount has to be typed into a banking app exactly. These accounts are
 * matched on the amount as well as the number, so a figure that is off by a
 * kobo is not a short payment — it is a payment that never arrives, against a
 * page that waits for it until the account expires. And the figure genuinely
 * carries kobo whenever fees are passed to the client, because the invoice is
 * grossed up so the freelancer still receives the whole of it: ₦53,750
 * becomes ₦54,670.06. Asking somebody to retype that is asking for the one
 * mistake this panel cannot absorb.
 *
 * And the page must survive being reloaded, because it reloads itself: it
 * polls for the payment and calls `location.reload()` the moment the money
 * lands. Anything a payer can be looking at therefore has to live at a URL
 * that answers GET. It did not, and somebody who had just transferred
 * ₦163,250 was shown "Route GET:/i/.../pay not found".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Civil } from "../../core/dates.ts";
import { renderDocument } from "./page.ts";
import type { PublicDocument } from "./public.ts";

const TODAY: Civil = { y: 2026, m: 9, d: 24 };

const doc = (over: Partial<PublicDocument> = {}): PublicDocument => ({
  id: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  type: "invoice",
  number: 2,
  status: "sent",
  businessName: "pysav",
  clientName: "danny",
  lines: [{ description: "Web dev", qty: 1, unitAmountKobo: 200_000_00, amountKobo: 200_000_00 }],
  subtotalKobo: 200_000_00,
  vatKobo: 15_000_00,
  totalKobo: 215_000_00,
  amountPaidKobo: 0,
  passFeesToClient: true,
  dueDate: { y: 2026, m: 10, d: 8 },
  issueDate: TODAY,
  notes: null,
  subAccountCode: "MFY_SUB_123",
  plan: "free",
  parts: [],
  // Priced in naira, like nearly every invoice this product sends.
  foreign: null,
  ...over,
});

const panel = (amountKobo: number) =>
  renderDocument(doc(), TODAY, {
    token: "a".repeat(32),
    transfer: {
      bankName: "Sterling bank",
      accountNumber: "2105486793",
      accountName: "Balans-Inv",
      amountKobo,
      ussd: null,
      expiresInMs: 39 * 60 * 1000,
    },
  });

/** What the copy button beside the amount would put on the clipboard. */
const copied = (html: string): string | null => {
  const row = html.slice(html.indexOf("Amount"));
  return /data-copy="([^"]*)"/.exec(row)?.[1] ?? null;
};

describe("copying the amount", () => {
  it("offers it beside the figure, not only in the words underneath", () => {
    const html = panel(54_670_06);
    assert.match(html, /class="icopy copy"/);
    assert.match(html, /aria-label="Copy the amount"/);
    // Still said in full in the sentence below, for anybody who would rather
    // read it than tap it — and for a phone with no clipboard permission.
    assert.match(html, /Send <strong>exactly ₦54,670\.06<\/strong>/);
  });

  it("copies what a banking app wants typed, not what the page shows", () => {
    /*
     * ₦54,670.06 is four characters of decoration around the number: a naira
     * sign and a thousands separator, both of which a transfer form rejects
     * or silently eats. Copying the displayed string means the payer deletes
     * them by hand, which is the retyping this is meant to remove.
     */
    assert.equal(copied(panel(54_670_06)), "54670.06");
  });

  it("leaves off a .00 nobody needs to type", () => {
    assert.equal(copied(panel(53_750_00)), "53750");
    assert.equal(copied(panel(1_000_000_00)), "1000000");
  });

  it("keeps a single kobo, because a kobo is what the match is on", () => {
    assert.equal(copied(panel(54_670_01)), "54670.01");
    assert.equal(copied(panel(54_670_10)), "54670.10");
  });

  it("shows a tick without throwing the icon away", () => {
    /*
     * The wide button says "Copied" by replacing its own text. Doing that to
     * a 34px square would leave the word where the icon was, so an icon
     * button swaps a class and CSS swaps the picture.
     */
    const html = panel(54_670_06);
    assert.match(html, /if \(b\.classList\.contains\('icopy'\)\)/, "the handler must know the difference");
    assert.match(html, /button\.icopy\.done \.i-no\{display:none\}/);
    assert.match(html, /button\.icopy\.done \.i-yes\{display:block\}/);
  });

  it("stays a real button, so a keyboard and a screen reader can reach it", () => {
    const html = panel(54_670_06);
    assert.match(html, /<button class="icopy copy" type="button"/);
    assert.match(html, /<svg class="i-no" viewBox="0 0 24 24" aria-hidden="true">/);
  });
});

describe("waiting for the transfer", () => {
  const routes = readFileSync(new URL("../http/routes/public.ts", import.meta.url), "utf8");

  it("reloads when the figure changes, not when anything has ever been paid", () => {
    /*
     * The refresh loop. The poll asked "has this been paid?" and a part-paid
     * invoice answers yes for ever — including on the page that had just been
     * drawn from that same fact. So it reloaded, asked again, was told the
     * same thing, and reloaded again, for as long as the invoice was open.
     *
     * Whether anything has moved is not a property of the document. It is a
     * comparison against what this page was drawn with, and only the page
     * knows that.
     */
    const html = panel(54_670_06);
    assert.match(html, /data-paid="0"/, "the page must carry what it was drawn with");
    assert.match(html, /var drawnWith = box\.getAttribute\('data-paid'\)/);
    assert.match(html, /String\(d\.paidKobo\) !== drawnWith/);
    assert.ok(!/d\.paid\b(?!Kobo)/.test(html), "the flag that caused the loop is back");
  });

  it("is drawn with what has been paid, so a part-paid invoice sits still", () => {
    // The case that looped: a deposit settled, the balance still to come.
    const html = renderDocument(doc({ amountPaidKobo: 53_750_00, status: "part_paid" }), TODAY, {
      token: "a".repeat(32),
      transfer: {
        bankName: "Sterling bank",
        accountNumber: "2105486793",
        accountName: "Balans-Inv",
        amountKobo: 163_250_00,
        ussd: null,
        expiresInMs: 39 * 60 * 1000,
      },
    });
    assert.match(html, /data-paid="5375000"/);
  });

  it("keeps asking the processor about payments it has not seen land", () => {
    /*
     * The other half of the same flag: once a deposit had succeeded, the poll
     * stopped walking the pending payments, so a balance whose webhook was
     * late could never be confirmed from the page at all.
     */
    const status = routes.slice(routes.indexOf('"/i/:token/status"'));
    const handler = status.slice(0, status.indexOf("/* -- Coming back from checkout"));

    assert.match(handler, /for \(const p of await pendingPaymentsFor\(doc\.id\)\)/);
    assert.ok(!/if \(!progress\.paid\)/.test(handler), "the confirm loop is gated again");
    assert.match(handler, /paidKobo: outcome\.amountPaidKobo/);
  });
});

describe("the page a payer is left looking at", () => {
  const routes = readFileSync(new URL("../http/routes/public.ts", import.meta.url), "utf8");

  it("is never the POST-only address", () => {
    /*
     * The account panel used to be the body of the POST, which left the
     * browser sitting at `/i/{token}/pay`. Then the payment landed, the page
     * reloaded itself, and the reload went out as a GET to a route that did
     * not answer one.
     */
    const pay = routes.slice(routes.indexOf('app.post<{ Params: { token: string } }>("/i/:token/pay"'));
    const handler = pay.slice(0, pay.indexOf("/* -- Has it landed yet?"));

    assert.ok(!/renderDocument\(/.test(handler), "the POST is rendering a page again");
    assert.match(handler, /reply\.redirect\(`\/i\/\$\{encodeURIComponent\(token\)\}/, "it must redirect");
    assert.match(handler, /, 303\)/, "303, so the reload after it is a GET");
  });

  it("answers that address anyway, for the histories it is already in", () => {
    assert.match(routes, /app\.get<\{ Params: \{ token: string \} \}>\("\/i\/:token\/pay"/);
  });

  it("carries a failure in the query string, where a reload can survive it", () => {
    // The error messages moved to the GET so that the page showing one is a
    // page that can be refreshed.
    assert.match(routes, /const PAY_ERRORS: Record<string, string> = \{/);
    for (const key of ["busy", "unpayable", "provider", "account"]) {
      assert.match(routes, new RegExp(`return again\\("${key}"\\)`), `${key} is not reachable`);
    }
    // Only ours. Anything else in the query string gets no words of ours on a
    // page about somebody's money.
    assert.match(routes, /req\.query\.e \? PAY_ERRORS\[req\.query\.e\] : undefined/);
  });
});
