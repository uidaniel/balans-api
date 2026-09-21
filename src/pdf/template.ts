/**
 * The document template (PRD F20).
 *
 * "One HTML template with variants for quote, invoice, receipt and sample."
 * One template, because the alternative is four that drift apart, and the
 * drift lands on the piece of paper somebody is being asked to pay.
 *
 * Everything is inline and nothing is fetched. A render that reaches out to a
 * CDN can hang, can fail, and tells that CDN which invoices are being made.
 * System fonts only: the document must look the same rendered on a laptop in
 * Lagos and in a container with no fonts installed.
 */

import { formatFriendly, formatISO, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { esc } from "../documents/page.ts";

export type Variant = "invoice" | "quote" | "receipt" | "sample";

export type DocumentData = {
  variant: Variant;
  number: number | null;
  /** The business issuing it. */
  businessName: string;
  businessEmail: string | null;
  businessAddress: string | null;
  businessTin: string | null;
  /** Data URI, or null. Pro only (F21). */
  logoDataUri: string | null;
  clientName: string;
  clientEmail: string | null;
  lines: { description: string; qty: number; unitAmountKobo: number; amountKobo: number }[];
  subtotalKobo: number;
  vatKobo: number;
  vatPercent: number | null;
  totalKobo: number;
  amountPaidKobo: number;
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
  };
  /** The two lines section 12 requires on everything a client sees. */
  legalLines: [string, string];
  /** Free plan (F9). */
  showMadeWith: boolean;
};

const TITLE: Record<Variant, string> = {
  invoice: "INVOICE",
  quote: "QUOTE",
  receipt: "RECEIPT",
  sample: "SAMPLE INVOICE",
};

/* Brand tokens, matching the web app and the public page. Duplicated because
   a PDF renders from a cold process with no shared stylesheet. */
const CSS = `
@page { size: A4; margin: 0 }
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:"Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif;
  color:#10231c;background:#fff;
  font-size:11pt;line-height:1.5;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.sheet{width:210mm;min-height:297mm;padding:18mm 16mm 14mm;position:relative;display:flex;flex-direction:column}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm}
.brand{display:flex;align-items:center;gap:3mm}
.logo{height:14mm;width:auto;max-width:48mm;object-fit:contain}
.dot{width:3.6mm;height:3.6mm;border-radius:50%;background:#f5b82e;flex:none}
.bizname{font-size:15pt;font-weight:700;letter-spacing:-.02em}
.bizmeta{margin-top:2mm;font-size:9pt;color:#5c6f66;line-height:1.45}
.title{text-align:right;flex:none}
.kind{font-size:19pt;font-weight:700;letter-spacing:.06em;color:#10231c}
.num{margin-top:1mm;font-size:11pt;color:#5c6f66}
.dates{margin-top:3mm;font-size:9.5pt;color:#5c6f66;line-height:1.6}
.dates b{color:#10231c;font-weight:600}
.parties{margin-top:12mm;display:flex;gap:10mm}
.party{flex:1}
.label{font-size:8pt;letter-spacing:.1em;text-transform:uppercase;color:#8a9a92;font-weight:600}
.party .who{margin-top:2mm;font-size:12pt;font-weight:600}
.party .sub{margin-top:1mm;font-size:9.5pt;color:#5c6f66}
table{width:100%;border-collapse:collapse;margin-top:10mm}
thead th{
  text-align:left;font-size:8pt;letter-spacing:.1em;text-transform:uppercase;
  color:#8a9a92;font-weight:600;padding:0 0 2.5mm;border-bottom:.4mm solid #10231c;
}
th.r,td.r{text-align:right}
th.c,td.c{text-align:center}
tbody td{padding:3.5mm 0;border-bottom:.2mm solid #ece7dc;vertical-align:top;font-size:10.5pt}
tbody td.desc{padding-right:8mm}
.totals{margin-top:6mm;margin-left:auto;width:78mm}
.trow{display:flex;justify-content:space-between;padding:1.6mm 0;font-size:10.5pt;color:#40534a}
.trow.grand{
  margin-top:2mm;padding-top:3mm;border-top:.5mm solid #10231c;
  font-size:14pt;font-weight:700;color:#10231c;
}
.trow.paid{color:#3f8f5f}
.paidstamp{
  margin-top:8mm;display:inline-block;padding:2.5mm 6mm;border-radius:2mm;
  background:#e4f2e9;color:#256b41;font-weight:700;font-size:11pt;letter-spacing:.02em;
}
.notes{margin-top:10mm;padding:5mm 6mm;background:#f6f1e7;border-radius:2mm;font-size:9.5pt;color:#40534a;white-space:pre-wrap}
.paybox{margin-top:10mm;padding:6mm;border:.3mm solid #e9e1d0;border-radius:2mm}
.paybox .label{margin-bottom:2mm}
.paybox .url{font-size:10pt;color:#10231c;word-break:break-all}
.foot{margin-top:auto;padding-top:12mm;font-size:7.8pt;color:#8a9a92;line-height:1.6}
.foot .made{margin-top:2mm;color:#a0aea7}
.watermark{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-50%) rotate(-28deg);
  font-size:74pt;font-weight:800;letter-spacing:.06em;
  color:rgba(16,35,28,.07);white-space:nowrap;pointer-events:none;
}
`;

export function renderDocumentHtml(d: DocumentData): string {
  const isReceipt = d.variant === "receipt";
  const owed = d.totalKobo - d.amountPaidKobo;

  const rows = d.lines
    .map(
      (l) => `<tr>
      <td class="desc">${esc(l.description)}</td>
      <td class="c">${fmtQty(l.qty)}</td>
      <td class="r">${formatNaira(l.unitAmountKobo)}</td>
      <td class="r">${formatNaira(l.amountKobo)}</td>
    </tr>`,
    )
    .join("");

  const dateLabel = d.variant === "quote" ? "Valid until" : "Due";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="sheet">

  ${d.variant === "sample" ? `<div class="watermark">SAMPLE</div>` : ""}

  <div class="head">
    <div>
      <div class="brand">
        ${
          d.logoDataUri
            ? `<img class="logo" src="${d.logoDataUri}" alt="">`
            : `<span class="dot"></span>`
        }
        <span class="bizname">${esc(d.businessName)}</span>
      </div>
      <div class="bizmeta">
        ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
        ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
        ${d.businessTin ? `TIN ${esc(d.businessTin)}` : ""}
      </div>
    </div>
    <div class="title">
      <div class="kind">${TITLE[d.variant]}</div>
      ${numberLine(d)}
      <div class="dates">
        ${d.issueDate ? `Issued <b>${formatFriendly(d.issueDate)}</b><br>` : ""}
        ${
          isReceipt && d.receipt
            ? `Paid <b>${formatFriendly(d.receipt.paidOn)}</b>`
            : d.dueDate
              ? `${dateLabel} <b>${formatFriendly(d.dueDate)}</b>`
              : ""
        }
      </div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <div class="label">${isReceipt ? "Received from" : "Billed to"}</div>
      <div class="who">${esc(d.clientName)}</div>
      ${d.clientEmail ? `<div class="sub">${esc(d.clientEmail)}</div>` : ""}
    </div>
    ${
      isReceipt && d.receipt
        ? `<div class="party">
             <div class="label">Payment</div>
             <div class="who">${esc(methodWords(d.receipt.method))}</div>
             <div class="sub">Ref ${esc(d.receipt.reference)}</div>
           </div>`
        : ""
    }
  </div>

  <table>
    <thead><tr>
      <th>Description</th><th class="c">Qty</th><th class="r">Rate</th><th class="r">Amount</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    ${
      d.vatKobo > 0
        ? `<div class="trow"><span>Subtotal</span><span>${formatNaira(d.subtotalKobo)}</span></div>
           <div class="trow"><span>VAT${d.vatPercent ? ` ${d.vatPercent}%` : ""}</span><span>${formatNaira(d.vatKobo)}</span></div>`
        : ""
    }
    <div class="trow grand"><span>${isReceipt ? "Paid" : "Total"}</span><span>${formatNaira(
      isReceipt ? d.amountPaidKobo : d.totalKobo,
    )}</span></div>
    ${
      !isReceipt && d.amountPaidKobo > 0
        ? `<div class="trow paid"><span>Paid</span><span>&minus;${formatNaira(d.amountPaidKobo)}</span></div>
           <div class="trow grand"><span>Balance</span><span>${formatNaira(owed)}</span></div>`
        : ""
    }
  </div>

  ${!isReceipt && owed <= 0 && d.totalKobo > 0 ? `<div class="paidstamp">PAID IN FULL</div>` : ""}
  ${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}

  ${
    d.publicUrl && !isReceipt && d.variant !== "sample" && owed > 0
      ? `<div class="paybox">
           <div class="label">Pay online</div>
           <div class="url">${esc(d.publicUrl)}</div>
         </div>`
      : ""
  }

  <div class="foot">
    ${esc(d.legalLines[0])}<br>${esc(d.legalLines[1])}
    ${d.showMadeWith ? `<div class="made">Made with Balans &middot; balans.ng</div>` : ""}
  </div>

</div></body></html>`;
}

function numberLine(d: DocumentData): string {
  if (d.variant === "receipt" && d.receipt) {
    return `<div class="num">No. ${d.receipt.number}${
      d.number === null ? "" : ` &middot; for Invoice ${d.number}`
    }</div>`;
  }
  return d.number === null ? "" : `<div class="num">No. ${d.number}</div>`;
}

/** "1", "2.5" — never "2.500", which looks like a price. */
function fmtQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)));
}

const METHOD_WORDS: Record<string, string> = {
  CARD: "Card",
  ACCOUNT_TRANSFER: "Bank transfer",
  DIRECT_DEBIT: "Direct debit",
  USSD: "USSD",
  PHONE_NUMBER: "Phone number",
  CASH: "Cash",
};

function methodWords(method: string | null): string {
  if (!method) return "Online";
  return METHOD_WORDS[method] ?? method.toLowerCase().replace(/_/g, " ");
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
