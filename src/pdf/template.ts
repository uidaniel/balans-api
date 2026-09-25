/**
 * The document template (PRD F20), and Classic, the layout it renders in.
 *
 * "One HTML template with variants for quote, invoice, receipt and sample."
 * One template, because the alternative is four that drift apart, and the
 * drift lands on the piece of paper somebody is being asked to pay.
 *
 * Classic lives here rather than beside the other seven because it is also
 * the fallback: a withdrawn or misspelled template id must still produce an
 * invoice. Everything it is drawn from is in `kit.ts`, which is the port of
 * the sheets on balans.ng — same rules, same sizes, same typefaces.
 *
 * Everything is inline and nothing is fetched. A render that reaches out to a
 * CDN can hang, can fail, and tells that CDN which invoices are being made.
 */

import { formatISO, type Civil } from "../../core/dates.ts";
import type { Foreign } from "../../core/currency.ts";
import { esc } from "../documents/page.ts";
import {
  biz,
  bizMeta,
  cap,
  dueLabel,
  field,
  headlineAmount,
  fxNote,
  ink,
  isReceipt,
  items,
  kind,
  legal,
  madeWith,
  methodWords,
  money,
  INK,
  MARIGOLD,
  MARIGOLD_DEEP,
  owedKobo,
  party,
  sheet,
  shortUrl,
  totals,
  when,
  type RenderOptions,
  onlineAt,
  payWhere,
} from "./kit.ts";

export type Variant = "invoice" | "quote" | "receipt" | "sample";

export type DocumentData = {
  variant: Variant;
  number: number | null;
  /**
   * The platform-wide reference, for support. Null on a sample and on
   * anything issued before references existed.
   *
   * `number` above is the invoice number the client reads and it restarts at
   * 1 for every freelancer, which is correct on the document and useless on
   * the phone: "invoice 2 has not been paid" names one invoice per user.
   */
  ref?: string | null;
  /** The business issuing it. */
  businessName: string;
  businessEmail: string | null;
  businessAddress: string | null;
  businessTin: string | null;
  /** Data URI, or null. Pro only (F21). */
  logoDataUri: string | null;
  /**
   * The sender's signature, as a data URI. Without one there is no signature
   * line at all: a ruled space for a pen, on a document nobody prints, only
   * ever said that something was missing.
   */
  signatureDataUri?: string | null;
  /**
   * The sender's own account, on a naira invoice (see bank-details.ts). Set,
   * it takes the place of the payment link everywhere a layout prints one.
   */
  bankDetails?: { bankName: string; accountName: string; accountNumber: string } | null;
  clientName: string;
  clientEmail: string | null;
  lines: { description: string; qty: number; unitAmountKobo: number; amountKobo: number }[];
  subtotalKobo: number;
  vatKobo: number;
  vatPercent: number | null;
  totalKobo: number;
  amountPaidKobo: number;
  /**
   * The price as agreed, when it was not agreed in naira (International PRD
   * section 9).
   *
   * Every other figure on this document stays kobo, including the table and
   * the totals, and that is deliberate. The table is what is *charged* — the
   * card is debited in naira and the client's own bank converts — and a sheet
   * whose lines are in dollars while its total is in naira is a sheet whose
   * arithmetic an accountant cannot check.
   *
   * So this appears twice and only twice: as the headline, because it is the
   * number two people agreed, and in the sentence under it that says what
   * will actually be charged.
   */
  foreign?: { currency: Foreign; amountMinor: number } | null;
  issueDate: Civil | null;
  dueDate: Civil | null;
  notes: string | null;
  /** Where the client can pay or check it. */
  publicUrl: string | null;
  /** Receipts only. */
  receipt?: {
    number: number;
    paidOn: Civil;
    method: string | null;
    reference: string;
    /**
     * What this one payment was, which is not what the document has been
     * credited with.
     *
     * The receipt is proof of a transfer, so the figure on its face is what
     * the client actually sent — grossed up by the processor's cut whenever
     * fees are passed on. `amountPaidKobo` stays the document's own running
     * total, so the "still owed" line on the same slip is the invoice's
     * arithmetic and not this payment's. Mixing the two produced a receipt
     * that disagreed with the invoice it was issued against.
     */
    amountKobo: number;
  };
  /** The two lines section 12 requires on everything a client sees. */
  legalLines: [string, string];
  /** Free plan (F9). */
  showMadeWith: boolean;
};

/* -------------------------------------------------------------------------- */
/* Classic                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The layout everybody starts on: the business first, then the amount, stated
 * early and in the one colour on the page.
 *
 * A marigold rule across the head and nothing else decorative. It is the
 * design that has to work for a photographer, a caterer and a law firm, so it
 * commits to nothing beyond being clear.
 */
const CSS = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.5em 1.8em 1.4em}
.brand-rule{height:.45em;flex:none;background:${MARIGOLD}}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.head .mail{margin-top:.4em;font-size:.6em;color:${ink(0.5)};
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.head .right{flex:none;text-align:right;font-size:.6em;line-height:1.55;color:${ink(0.5)}}
.band{margin-top:1.4em;display:flex;align-items:flex-start;justify-content:space-between;gap:1em;
border-top:1px solid ${ink(0.12)};padding-top:1em}
.band .amt{margin-top:.2em;font-size:1.4em;line-height:1;font-weight:800;
font-variant-numeric:tabular-nums;color:${MARIGOLD_DEEP}}
.band .amt.off{color:${ink(0.75)}}
.dates{margin-top:.9em;display:flex;justify-content:space-between;gap:1em;
border-top:1px solid ${ink(0.12)};padding-top:.9em}
.work{margin-top:1.3em}
.terms{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1em;padding-top:1.2em}
.terms .thanks{font-size:.62em;font-weight:600}
.terms .where{margin-top:.3em;font-size:.58em;color:${ink(0.45)};
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.terms .where b{font-weight:600;color:${INK}}
.terms .mail{flex:none;font-size:.58em;color:${ink(0.4)}}
.notes{margin-top:1.1em;font-size:.58em;line-height:1.6;color:${ink(0.6)};white-space:pre-wrap}
`;

export function renderDocumentHtml(d: DocumentData, opts: RenderOptions = {}): string {
  const h = headlineAmount(d);
  const receipt = isReceipt(d) && d.receipt ? d.receipt : null;

  /* The middle band: who it is for, which document this is, and the amount.
     A client reading it on a phone should be able to stop after this line. */
  const band = `<div class="band">
    ${field("Billed to", party(d.clientName, d.clientEmail), "min0")}
    ${
      receipt
        ? field("Receipt number", `#${receipt.number}`)
        : d.number === null
          ? ""
          : field(`${kind(d)} number`, `#${d.number}`)
    }
    <div style="flex:none;text-align:right">
      ${cap(`${h.label} (${h.currency})`)}
      <p class="amt ${h.paid ? "off" : ""}">${h.display}</p>
    </div>
  </div>
  ${
    /*
     * Under the band rather than in the amount cell beside it. That cell is
     * one column of a flex row sized for a figure, and a sentence in it does
     * not wrap politely — it widens the column until the other two collapse
     * to one character per line and the amount itself is pushed off the
     * sheet. Which is what happened.
     */
    fxNote(d)
  }`;

  /* The dates, and on a receipt how it was paid — the two questions somebody
     puts an invoice in a folder to be able to answer later. */
  const facts = [
    d.issueDate ? field("Issue date", when(d.issueDate)) : "",
    receipt
      ? field("Paid on", when(receipt.paidOn))
      : d.dueDate
        ? field(dueLabel(d), when(d.dueDate))
        : "",
    receipt ? field("Payment", esc(methodWords(receipt.method))) : "",
    receipt ? field("Reference", esc(receipt.reference)) : "",
  ].filter(Boolean);

  const body = `<div class="brand-rule"></div>
<div class="wrap">
  <div class="head">
    <div class="min0">
      ${biz(d)}
      ${d.businessEmail ? `<p class="mail">${esc(d.businessEmail)}</p>` : ""}
    </div>
    <div class="right">${bizMeta(d, ["address", "tin"])}</div>
  </div>

  ${band}

  ${facts.length ? `<div class="dates">${facts.join("")}</div>` : ""}

  <div class="work">
    ${items(d)}
    ${totals(d)}
  </div>

  ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ""}

  <div class="terms">
    <div class="min0">
      <p class="thanks">${receipt ? "Thank you for the payment." : "Thanks for the business."}</p>
      ${
        payWhere(d)
          ? `<p class="where">${payWhere(d)}</p>`
          : d.publicUrl
            ? `<p class="where">See it any time at <b>${esc(shortUrl(d.publicUrl))}</b></p>`
            : ""
      }
    </div>
    ${d.showMadeWith ? madeWith(d) : d.businessEmail ? `<p class="mail">${esc(d.businessEmail)}</p>` : ""}
  </div>

  ${legal(d)}
</div>`;

  // Classic lists the work in the wider Free table, whose rows are taller.
  return sheet(d, opts, { css: CSS, body, rowEm: 1.6 });
}

/** The stable identity of a rendered document, for the snapshot (F20). */
export const snapshotOf = (d: DocumentData): Record<string, unknown> => ({
  variant: d.variant,
  number: d.number,
  businessName: d.businessName,
  clientName: d.clientName,
  lines: d.lines,
  subtotalKobo: d.subtotalKobo,
  vatKobo: d.vatKobo,
  totalKobo: d.totalKobo,
  issueDate: d.issueDate ? formatISO(d.issueDate) : null,
  dueDate: d.dueDate ? formatISO(d.dueDate) : null,
});
