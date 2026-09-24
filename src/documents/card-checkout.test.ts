/**
 * One checkout per invoice, however often Pay is pressed.
 *
 * The transfer side has always reused what was already issued: somebody who
 * goes to their banking app and comes back must meet the same account they
 * copied. The card side had no equivalent, so every press of Pay called
 * Paystack again and opened another transaction.
 *
 * Two real invoices showed it. One pair of references 363ms apart, which is
 * a browser submitting the form twice rather than a person, and one pair 61
 * seconds apart, which is a person pressing again. Each left a stray
 * `initialised` row, and — the part that matters — each was a live
 * transaction a client could have paid. Two open transactions for one invoice
 * is how the same bill gets paid twice, and the rate limiter is no help: it
 * allows eight a minute, which is eight ways to be charged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const payments = readFileSync(new URL("./payments.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../http/routes/public.ts", import.meta.url), "utf8");

describe("the checkout that is already open", () => {
  it("is looked for before another one is started", () => {
    /*
     * Order is the whole fix. Asking afterwards would find the transaction
     * this request had just created and prove nothing, so the check has to
     * sit above the call to Paystack.
     */
    const card = routes.slice(routes.indexOf("async function payByCard"));
    const body = card.slice(0, card.indexOf("\n  }\n"));

    const lookup = body.indexOf("liveCardCheckoutFor(doc.id, outstandingKobo)");
    const create = body.indexOf("await initPaystack(");
    assert.ok(lookup > -1, "payByCard never asks whether a checkout is already open");
    assert.ok(create > -1, "payByCard no longer starts a transaction at all");
    assert.ok(lookup < create, "it asks only after opening a second transaction");

    assert.match(body, /return reply\.redirect\(open\.checkoutUrl, 303\)/, "and goes back to it");
  });

  it("keeps the address so there is something to go back to", () => {
    // Without this the reuse has nothing to hand over. It rides in
    // `raw_verify_json`, which the confirmation later overwrites with the
    // real verify response — by which point the checkout is spent anyway.
    assert.match(routes, /checkoutUrl: init\.authorizationUrl/);
    assert.match(payments, /\.\.\.\(p\.checkoutUrl \? \{ checkoutUrl: p\.checkoutUrl \} : \{\}\)/);
  });

  it("matches on the amount, not just the document", () => {
    /*
     * A part payment landing between the two presses changes what is owed.
     * Handing back the earlier checkout would then charge a figure nobody
     * owes any more — the same reason `liveTransferFor` matches on it.
     */
    const fn = payments.slice(payments.indexOf("export async function liveCardCheckoutFor"));
    assert.match(fn, /COALESCE\(invoice_amount_kobo, client_total_kobo\) = \$2/);
  });

  it("will not hand back a transfer, or a payment that is already spent", () => {
    const fn = payments.slice(payments.indexOf("export async function liveCardCheckoutFor"));
    assert.match(fn, /provider = 'paystack'/, "a Monnify transfer has no checkout page");
    assert.match(fn, /status = 'initialised'/, "a paid or failed payment is not somewhere to send anybody");
  });

  it("stops offering one old enough to have been timed out", () => {
    /*
     * The opposite failure: a link Paystack has since expired, handed to
     * somebody as though it were live. Bounded rather than indefinite, and
     * the window is stated once.
     */
    const fn = payments.slice(payments.indexOf("export async function liveCardCheckoutFor"));
    assert.match(fn, /created_at > now\(\) - \(\$3 \|\| ' minutes'\)::interval/);
    assert.match(payments, /const CHECKOUT_REUSE_MINUTES = \d+;/);
  });
});
