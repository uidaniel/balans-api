/**
 * The public page.
 *
 * Two things are being checked. That the page tells the truth about money and
 * status, and that nothing a user types can escape into the markup — this is
 * the only page in the system rendered from user input and shown to a third
 * party, so it is the only place where that mistake reaches a stranger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Civil } from "../../core/dates.ts";
import { esc, renderDocument, renderNotFound } from "./page.ts";
import { outstandingKobo, payable, type PublicDocument } from "./public.ts";
import { askFor, draftSummary, sentMessage } from "./summary.ts";
import {
  debtorsMessage,
  limitReachedMessage,
  notFoundMessage,
  statusMessage,
  summaryMessage,
} from "./reports.ts";

const TODAY: Civil = { y: 2026, m: 9, d: 23 };

const doc = (over: Partial<PublicDocument> = {}): PublicDocument => ({
  id: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  type: "invoice",
  number: 7,
  status: "sent",
  businessName: "Kemi Adeyemi Studio",
  clientName: "Zenith Homes",
  lines: [{ description: "duplex 3D render", qty: 1, unitAmountKobo: 350_000_00, amountKobo: 350_000_00 }],
  subtotalKobo: 350_000_00,
  vatKobo: 0,
  totalKobo: 350_000_00,
  amountPaidKobo: 0,
  passFeesToClient: false,
  dueDate: { y: 2026, m: 9, d: 25 },
  issueDate: TODAY,
  notes: null,
  subAccountCode: "MFY_SUB_123",
  plan: "free",
  // No parts by default: an ordinary invoice is one payment.
  parts: [],
  // Priced in naira, like nearly every invoice this product sends.
  foreign: null,
  ...over,
});

const render = (d: PublicDocument) => renderDocument(d, TODAY, { token: "a".repeat(32) });

describe("what the page says", () => {
  it("shows the amount, who it is from, and who it is for", () => {
    const html = render(doc());
    assert.match(html, /₦350,000/);
    assert.match(html, /Kemi Adeyemi Studio/);
    assert.match(html, /Zenith Homes/);
    assert.match(html, /duplex 3D render/);
    assert.match(html, /Invoice 7/);
  });

  it("offers a Pay button for the amount owed", () => {
    const html = render(doc());
    assert.match(html, /Pay ₦350,000/);
    assert.match(html, /action="\/i\/a{32}\/pay"/);
    assert.match(html, /method="post"/);
  });

  it("shows VAT only when there is some", () => {
    assert.doesNotMatch(render(doc()), /VAT/);
    const withVat = render(doc({ vatKobo: 26_250_00, totalKobo: 376_250_00 }));
    assert.match(withVat, /VAT/);
    assert.match(withVat, /₦26,250/);
  });

  it("shows what is still owed after a part payment", () => {
    const html = render(doc({ amountPaidKobo: 100_000_00, status: "part_paid" }));
    assert.match(html, /Still owed/);
    assert.match(html, /₦250,000/);
    assert.match(html, /Pay ₦250,000/, "the button pays the balance, not the total");
  });

  it("says when an invoice is late", () => {
    const html = render(doc({ dueDate: { y: 2026, m: 9, d: 1 } }));
    assert.match(html, /Was due/);
  });

  it("does not shout about a date that has not come", () => {
    assert.doesNotMatch(render(doc()), /Was due/);
    assert.match(render(doc()), /Due Fri, 25 Sep/);
  });
});

describe("what the page refuses to do", () => {
  it("will not take money for a paid invoice", () => {
    const html = render(doc({ status: "paid", amountPaidKobo: 350_000_00 }));
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /Paid in full/);
  });

  it("will not take money for a cancelled one", () => {
    const html = render(doc({ status: "cancelled" }));
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /cancelled/i);
  });

  it("will not take money for a quote", () => {
    const html = render(doc({ type: "quote" }));
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /quote, not an invoice/i);
    assert.match(html, /Valid until/);
  });

  it("will not take money with nowhere to settle it", () => {
    // Without a subaccount the payment would land in our own wallet, which is
    // the one thing this product must never do.
    const html = render(doc({ subAccountCode: null }));
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /not set up/i);
  });

  it("never states an amount the document does not hold", () => {
    const html = render(doc());
    // The only amounts on the page are the line, the total and the button.
    const amounts = [...html.matchAll(/₦[\d,]+(?:\.\d{2})?/g)].map((m) => m[0]);
    for (const a of amounts) assert.equal(a, "₦350,000", `stray amount ${a}`);
  });
});

describe("nothing a user types can escape", () => {
  const nasty = '<script>alert(1)</script>" onmouseover="alert(2)';

  it("escapes the business name", () => {
    const html = render(doc({ businessName: nasty }));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("escapes the client name", () => {
    const html = render(doc({ clientName: nasty }));
    assert.doesNotMatch(html, /<script>/);
  });

  it("escapes a line description", () => {
    const html = render(doc({ lines: [{ description: nasty, qty: 1, unitAmountKobo: 100, amountKobo: 100 }] }));
    assert.doesNotMatch(html, /<script>/);
  });

  it("escapes notes, which are free text and the longest field", () => {
    const html = render(doc({ notes: nasty }));
    assert.doesNotMatch(html, /<script>/);
  });

  it("escapes quotes, so nothing breaks out of an attribute", () => {
    assert.equal(esc('" onmouseover="x'), "&quot; onmouseover=&quot;x");
    assert.equal(esc("it's"), "it&#39;s");
    assert.equal(esc("a & b"), "a &amp; b");
    // Ampersands first, or the escapes themselves get double-escaped.
    assert.equal(esc("<&>"), "&lt;&amp;&gt;");
  });

  it("adds no tag to the markup, whatever the fields contain", () => {
    // Counting rather than searching: the page has its own <b> around the
    // business name, so the question is not whether a tag is present but
    // whether the input put one there.
    const tags = (html: string) => (html.match(/<[a-z][a-z0-9]*[\s>]/gi) ?? []).length;

    const benign = render(
      doc({
        businessName: "Studio",
        clientName: "Zenith",
        notes: "thanks",
        lines: [{ description: "render", qty: 1, unitAmountKobo: 100, amountKobo: 100 }],
      }),
    );
    const hostile = render(
      doc({
        businessName: "<b>bold</b>",
        clientName: "<i>italic</i>",
        notes: "<u>under</u><script>alert(1)</script>",
        lines: [{ description: "<em>em</em><img src=x onerror=alert(1)>", qty: 1, unitAmountKobo: 100, amountKobo: 100 }],
      }),
    );

    assert.equal(tags(hostile), tags(benign), "hostile input added tags to the page");
    // No opening tag survived. The words themselves may remain — "onerror" as
    // escaped text is just a word — and what matters is that nothing can open
    // an element to hang it on.
    //
    // Checked against what the input tried to open, not against the tag names
    // in the abstract: the page has an <img> of its own for the processor's
    // mark, and the count above is what proves the input added none.
    assert.doesNotMatch(hostile, /<script/i, "a script tag was opened");
    assert.doesNotMatch(hostile, /<img[^>]*onerror/i, "an event handler was opened");
    assert.doesNotMatch(hostile, /<img\s+src=x/i, "the input's img rendered");
    assert.doesNotMatch(hostile, /<b>bold|<i>italic|<u>under|<em>em/i, "input markup rendered");
    // And it is still visible to the reader, just as text.
    assert.match(hostile, /&lt;script&gt;/);
    assert.match(hostile, /&lt;img src=x onerror/);
  });
});

describe("the page keeps the user's business to themselves", () => {
  it("never renders anything that is not on the document", () => {
    // The client sees what they are being billed. Not a phone number, not an
    // email, not a bank account, not a subaccount code.
    const html = render(doc());
    assert.ok(!html.includes("MFY_SUB_123"), "the subaccount code must not be in the page");
    assert.ok(!html.includes("22222222"), "the user id must not be in the page");
    assert.ok(!html.includes("11111111"), "the document id must not be in the page");
  });

  it("asks search engines to stay away", () => {
    assert.match(render(doc()), /noindex/);
    assert.match(renderNotFound(), /noindex/);
  });
});

describe("a token that leads nowhere", () => {
  it("gives away nothing about whether it was ever real", () => {
    const html = renderNotFound();
    assert.match(html, /Nothing here/);
    assert.doesNotMatch(html, /invoice|expired token|deleted/i);
  });
});

describe("payable, as a rule rather than a rendering", () => {
  it("agrees with what the page shows", () => {
    const cases: [Partial<PublicDocument>, boolean][] = [
      [{}, true],
      [{ status: "viewed" }, true],
      [{ status: "overdue" }, true],
      [{ status: "part_paid", amountPaidKobo: 100_000_00 }, true],
      [{ status: "paid", amountPaidKobo: 350_000_00 }, false],
      [{ status: "cancelled" }, false],
      [{ type: "quote" }, false],
      [{ type: "sample" }, false],
      [{ subAccountCode: null }, false],
      [{ amountPaidKobo: 350_000_00 }, false],
    ];
    for (const [over, expected] of cases) {
      const d = doc(over);
      assert.equal(payable(d).ok, expected, JSON.stringify(over));
      assert.equal(render(d).includes("<button"), expected, `page disagrees: ${JSON.stringify(over)}`);
    }
  });

  it("never reports a negative balance", () => {
    // An overpayment is a refund problem, not a "we owe you a Pay button".
    assert.equal(outstandingKobo(doc({ amountPaidKobo: 400_000_00 })), 0);
  });
});

describe("the messages that go with a document", () => {
  // The same one-emoji budget the conversation keeps. These were outside the
  // machine's VOICE object and so outside the test that enforces it.
  const EMOJI = /\p{Extended_Pictographic}/gu;
  const firstLine = (m: string) => m.split("\n")[0];

  const messages = () => {
    const d = doc();
    const draft = {
      ...d,
      clientEmail: null,
      lines: d.lines.map((l) => ({ ...l })),
      vatPercent: null,
      depositPercent: null,
      publicToken: null,
    } as never;
    const sent = sentMessage(draft, { number: 7, publicToken: "abc" }, "https://balans.ng", TODAY);
    return [
      draftSummary(draft, TODAY, "free"),
      // One message now: the note travels inside the caption rather than
      // following as a second bubble, so there are no longer two halves.
      sent.forward,
      askFor("client_name", {}),
      askFor("amount", { clientName: "Zenith" }),
      askFor("description", {}),
      askFor("due_date", {}),
    ];
  };

  it("uses at most one emoji, at the very start", () => {
    for (const m of messages()) {
      const found = m.match(EMOJI) ?? [];
      assert.ok(found.length <= 1, `${found.length} emoji in: ${firstLine(m)}`);
      if (found.length === 1) {
        assert.ok(m.startsWith(found[0]!), `emoji must lead: ${firstLine(m)}`);
      }
    }
  });

  it("uses WhatsApp bold, not Markdown", () => {
    for (const m of messages()) assert.ok(!m.includes("**"), `Markdown bold in: ${m}`);
  });
});

describe("the messages that report on the books", () => {
  const EMOJI = /\p{Extended_Pictographic}/gu;
  const firstLine = (m: string) => m.split("\n")[0];

  const debt = {
    number: 3, clientName: "Zenith Homes", outstandingKobo: 350_000_00,
    dueDate: { y: 2026, m: 7, d: 20 }, daysLate: 65, status: "overdue",
  };

  const messages = () => [
    debtorsMessage({ rows: [debt], totalKobo: 350_000_00, more: 2, moreKobo: 5_000_00 }, TODAY),
    debtorsMessage({ rows: [], totalKobo: 0, more: 0, moreKobo: 0 }, TODAY),
    statusMessage(
      { number: 3, type: "invoice", clientName: "Zenith Homes", status: "viewed",
        totalKobo: 350_000_00, paidKobo: 0, dueDate: { y: 2026, m: 9, d: 25 },
        sentAt: new Date(), viewedAt: new Date(), paidAt: null, publicToken: "abc" },
      TODAY, "https://balans.ng",
    ),
    summaryMessage({
      period: { from: TODAY, to: TODAY, label: "this month" },
      invoicedKobo: 100_000_00, documents: 2, paidKobo: 50_000_00,
      outstandingKobo: 50_000_00, overdueKobo: 0,
      topClients: [{ name: "Zenith", paidKobo: 50_000_00 }],
    }),
    limitReachedMessage(5, 5, { y: 2026, m: 9, d: 23 }),
    notFoundMessage({ clientName: "Zenith" }),
    notFoundMessage({ number: 3 }),
    notFoundMessage({}),
  ];

  it("renders every emoji as an emoji", () => {
    // A Python-style escape written into a TypeScript template literal ends up
    // in the message as the text "U0001f4b0". This is what says so.
    for (const m of messages()) {
      assert.doesNotMatch(m, /U[0-9a-f]{4,8}/i, `unrendered escape in: ${firstLine(m)}`);
      assert.doesNotMatch(m, /\\u[0-9a-f]{4}/i, `unrendered escape in: ${firstLine(m)}`);
    }
  });

  it("uses at most one emoji, at the very start", () => {
    for (const m of messages()) {
      const found = m.match(EMOJI) ?? [];
      assert.ok(found.length <= 1, `${found.length} emoji in: ${firstLine(m)}`);
      if (found.length === 1) {
        assert.ok(m.startsWith(found[0]!), `emoji must lead: ${firstLine(m)}`);
      }
    }
  });

  it("never calls the user's clients debtors", () => {
    // F14: "Client-facing surfaces never use the word debtor." Nor does this
    // one — the user is not a bank.
    for (const m of messages()) assert.doesNotMatch(m, /debtor/i, m);
  });

  it("uses WhatsApp bold, not Markdown", () => {
    for (const m of messages()) assert.ok(!m.includes("**"), `Markdown bold in: ${m}`);
  });
});
