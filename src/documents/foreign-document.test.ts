/**
 * What a client abroad is shown, on the page and on the sheet.
 *
 * Section 9 and acceptance criterion 10: the agreed price, the naira charge,
 * the bank disclaimer, and never anything about the freelancer's side of it.
 *
 * The bug these exist because of was found by rendering a PDF and looking at
 * it. Three of the eight layouts call the shared `due()` helper and five build
 * their own header, so teaching `due()` about currency left a $500 invoice
 * headed "TOTAL DUE (NGN) ₦663,500" with the agreed price nowhere on the
 * page — a perfectly well-formed document quoting a figure the client never
 * agreed to. Nothing about it looked wrong except the number.
 *
 * So the rule is not "the headline renders the currency"; it is that no
 * layout formats the headline itself. `headlineAmount` returns the string to
 * print, and these tests hold every layout to using it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Civil } from "../../core/dates.ts";
import { renderDocument } from "./page.ts";
import type { PublicDocument } from "./public.ts";
import { renderTemplate } from "../pdf/templates.ts";
import { headlineAmount } from "../pdf/kit.ts";
import type { DocumentData } from "../pdf/template.ts";

const TODAY: Civil = { y: 2026, m: 9, d: 24 };

/** $500 at 1,327, which is the PRD's worked example. */
const sheet = (over: Partial<DocumentData> = {}): DocumentData => ({
  variant: "invoice",
  number: 2,
  ref: "BL-0004",
  businessName: "pysav",
  businessEmail: "hello@pysav.ng",
  businessAddress: null,
  businessTin: null,
  logoDataUri: null,
  clientName: "Acme Ltd",
  clientEmail: "ap@acme.co.uk",
  lines: [
    { description: "Brand identity", qty: 1, unitAmountKobo: 663_500_00, amountKobo: 663_500_00 },
  ],
  subtotalKobo: 663_500_00,
  vatKobo: 0,
  vatPercent: null,
  totalKobo: 663_500_00,
  amountPaidKobo: 0,
  foreign: { currency: "USD", amountMinor: 500_00 },
  issueDate: TODAY,
  dueDate: { y: 2026, m: 10, d: 2 },
  notes: null,
  publicUrl: `https://payment.balans.ng/i/${"a".repeat(32)}`,
  legalLines: ["Issued by pysav via Balans", "Payments processed by Paystack"],
  showMadeWith: false,
  ...over,
});

const page = (over: Partial<PublicDocument> = {}): PublicDocument => ({
  id: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  type: "invoice",
  number: 2,
  status: "sent",
  businessName: "pysav",
  clientName: "Acme Ltd",
  lines: [
    {
      description: "Brand identity",
      qty: 1,
      unitAmountKobo: 663_500_00,
      amountKobo: 663_500_00,
      originalAmountMinor: 500_00,
    },
  ],
  subtotalKobo: 663_500_00,
  vatKobo: 0,
  totalKobo: 663_500_00,
  amountPaidKobo: 0,
  passFeesToClient: false,
  dueDate: { y: 2026, m: 10, d: 2 },
  issueDate: TODAY,
  notes: null,
  subAccountCode: "ACCT_yxs6g56bmt5ykjq",
  plan: "pro",
  parts: [],
  foreign: { currency: "USD", amountMinor: 500_00, rate: 1327 },
  ...over,
});

describe("the price on the page", () => {
  const html = () => renderDocument(page(), TODAY, { token: "a".repeat(32) });

  it("leads with what the two of them agreed", () => {
    assert.match(html(), /<h1>\$500\.00<\/h1>/);
  });

  it("says what will actually leave the client's account, and who converts it", () => {
    /*
     * Section 9, word for word, and the reason is not politeness. The naira
     * figure is what appears on their statement; meeting it there for the
     * first time is how somebody decides they were overcharged by whoever
     * sent the invoice.
     */
    const out = html();
    assert.match(out, /Charged in Naira as <b>₦663,500<\/b>/);
    assert.match(out, /Your bank converts this and may apply its own exchange rate or fees/);
  });

  it("itemises in the currency each line was quoted in", () => {
    // A client who agreed to $500 for the brand identity should not have to
    // work out whether ₦663,500 is the same thing.
    assert.match(html(), /Brand identity<\/td><td class="r">\$500\.00<\/td>/);
  });

  it("charges in naira on the button, because that is what the button does", () => {
    // The headline is a price two people agreed. The button is a figure about
    // to leave a bank account, and one that said "$500" would charge a
    // different number than it read.
    assert.match(html(), /Pay ₦663,500 by card/);
  });

  it("keeps what is still owed in naira", () => {
    /*
     * It was part-paid in naira and it is charged in naira, and there is no
     * dollar figure for the remainder that anybody agreed to. Converting it
     * back would print a price that moves with the rate.
     */
    const part = renderDocument(page({ amountPaidKobo: 300_000_00, status: "part_paid" }), TODAY, {
      token: "a".repeat(32),
    });
    assert.match(part, /Still owed<\/span><span>₦363,500<\/span>/);
    assert.ok(!part.includes("$274"), "the balance was converted back into dollars");
  });

  it("says nothing about the freelancer's side of it", () => {
    // The client agreed to a price, not to somebody else's margins.
    const out = html().toLowerCase();
    for (const leak of ["you receive", "balans fee", "paystack fee", "after fees", "payout"]) {
      assert.ok(!out.includes(leak), `the page tells the client about "${leak}"`);
    }
  });

  it("names the processor that is actually going to take the card", () => {
    /*
     * The badge is the one place this page tells a stranger where the card
     * details they are about to type are going, and it said Monnify on every
     * document — including a dollar invoice whose only button opens
     * Paystack's checkout. A claim the very next screen contradicts is worse
     * than no claim: it is checkable, and it does not check out.
     *
     * Naira is collected by Monnify and anything else by Paystack, so this is
     * `doc.foreign` and nothing else.
     */
    const out = html();
    assert.match(out, /Payments processed by[\s\S]*?Paystack/);
    assert.ok(!/alt="Monnify"|<b>Monnify<\/b>/.test(out), "the wrong company on a card page");
  });

  it("leaves a naira invoice exactly as it was", () => {
    const naira = renderDocument(
      page({
        foreign: null,
        lines: [
          { description: "Duplex render", qty: 1, unitAmountKobo: 350_000_00, amountKobo: 350_000_00 },
        ],
        subtotalKobo: 350_000_00,
        totalKobo: 350_000_00,
      }),
      TODAY,
      { token: "a".repeat(32) },
    );
    assert.match(naira, /<h1>₦350,000<\/h1>/);
    assert.ok(!naira.includes("Charged in Naira"), "a naira invoice explained its own currency");
    assert.match(naira, /Pay ₦350,000/);
    assert.ok(!naira.includes("by card"), "naira is paid by transfer");
    // Including its badge: Monnify is still who collects a transfer.
    assert.match(naira, /Payments processed by[\s\S]*?Monnify/);
    assert.ok(!naira.includes("Paystack"), "a naira transfer credited to the card processor");
  });
});

describe("the price on the sheet", () => {
  /*
   * Every layout, not a sample of them. This is the check that would have
   * caught the Classic header: three of the eight go through `due()` and five
   * write their own, and the five were wrong while the three were right.
   */
  const IDS = [null, "classic", "ledger", "statement", "studio", "column", "mono", "band"];

  for (const id of IDS) {
    it(`prints the agreed price on ${id ?? "the default layout"}`, () => {
      // A layout id nobody recognises falls back to the default, and a
      // fallback still has to be right — so null here is a failure, not a
      // skip.
      const html = renderTemplate(id, sheet());
      assert.ok(html, `${id ?? "default"} rendered nothing`);
      assert.ok(html.includes("$500.00"), `${id ?? "default"} does not show the agreed price`);
      assert.ok(
        !/TOTAL DUE \(NGN\)/i.test(html),
        `${id ?? "default"} labels a dollar invoice as naira`,
      );
    });

    it(`explains the conversion on ${id ?? "the default layout"}`, () => {
      const html = renderTemplate(id, sheet());
      assert.ok(html);
      assert.match(html, /Charged in Naira as/);
    });
  }

  it("keeps the table and the totals in naira", () => {
    /*
     * What is charged. A sheet whose lines are in dollars and whose total is
     * in naira is a sheet an accountant cannot check, and this one may be
     * filed by somebody who was not in the conversation.
     */
    const html = renderTemplate(null, sheet());
    assert.ok(html);
    assert.match(html, /Subtotal<\/span><span class="tnum">₦663,500<\/span>/);
    assert.match(html, /Total<\/span><span class="tnum">₦663,500<\/span>/);
    // And the agreed price appears once, as the headline, rather than leaking
    // into the arithmetic below it.
    assert.equal((html.match(/\$500\.00/g) ?? []).length, 1);
  });

  it("does not offer a foreign price for a figure nobody quoted", () => {
    /*
     * Part-paid. What is left is a naira quantity — charged in naira,
     * credited in naira — and there is no dollar amount for it that anybody
     * agreed to. The headline falls back rather than inventing one.
     */
    const part = headlineAmount(sheet({ amountPaidKobo: 300_000_00 }));
    assert.equal(part.currency, "NGN");
    assert.equal(part.display, "₦363,500");

    const whole = headlineAmount(sheet());
    assert.equal(whole.currency, "USD");
    assert.equal(whole.display, "$500.00");
  });

  it("is never formatted by a layout itself", () => {
    /*
     * The rule the bug broke. A layout that formats `h.amount` is a layout
     * that will print naira on a dollar invoice the day somebody adds a
     * ninth one, and it will look completely normal.
     */
    for (const file of ["../pdf/templates.ts", "../pdf/template.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.ok(
        !src.includes("money(h.amount)"),
        `${file} formats the headline itself instead of using h.display`,
      );
    }
  });
});
