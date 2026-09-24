/**
 * The receipt, which is not an invoice with a different word at the top.
 *
 * It was one. A receipt rendered as the Classic layout — the same A4 sheet,
 * the same billing table, the same four columns — with "Receipt" where
 * "Invoice" had been. That is the cheap answer and it is wrong twice.
 *
 * It is wrong about what the document is. An invoice is a request and it has
 * to argue for itself: here is the work, here is the rate, here is what it
 * comes to, here is when you owe it. A receipt argues nothing. The money has
 * moved. It answers three questions — how much, when, and against what — and
 * everything else on the page is there to be filed, not read.
 *
 * And it is wrong about the moment. A receipt arrives seconds after somebody
 * has paid, into a chat, and is opened on a phone. A full page of ruled table
 * is a document somebody has to scan for the number that matters. A slip has
 * one.
 *
 * So: a till receipt, centred on the page, because that is the shape everyone
 * already knows means "this is settled". Paper stock, a torn edge, leader
 * dots running from each label to its figure, and the amount set larger than
 * anything else on it. The same house colours and the same typefaces as the
 * eight invoice layouts, so it is recognisably from the same product — this
 * is a different kind of document, not a different brand.
 *
 * Deliberately not one of the eight. A freelancer picks how their *invoices*
 * look, which is their document going out under their name; a receipt is
 * proof of a payment and there is nothing to choose about it. One receipt,
 * the same for everybody, is also one thing to get right.
 */

import { esc } from "../documents/page.ts";
import {
  biz,
  bizMeta,
  DISPLAY,
  ink,
  legal,
  madeWith,
  methodWords,
  money,
  owedKobo,
  shortUrl,
  when,
  CREAM,
  INK,
  MOSS,
  type RenderOptions,
} from "./kit.ts";
import { sheet } from "./kit.ts";
import type { DocumentData } from "./template.ts";

/** The slip's own paper, a shade off the page so its edges read as cut. */
const STOCK = "#FDFBF6";

/*
 * The torn edge, cut rather than drawn.
 *
 * Mirrored background gradients are the usual trick and they produced
 * castellations: squared battlements, not a tear. A sawtooth needs its
 * points on the diagonal of each tile, which a gradient only gives you when
 * the tile happens to be square.
 *
 * So the shape is generated instead — one polygon, a point per tooth, cut
 * out of the slip itself. Exact at any width, and it takes the paper's own
 * background with it, which is what makes the teeth read as the page showing
 * through rather than as something printed on top.
 */
const TOOTH_MM = 3.4;
const TEETH = 24;

/** The slip, with a row of teeth bitten out of its foot. */
function tornEdge(): string {
  const pts = [`0 0`, `100% 0`, `100% calc(100% - ${TOOTH_MM}mm)`];
  const step = 100 / TEETH;
  for (let i = TEETH - 1; i >= 0; i--) {
    pts.push(`${((i + 0.5) * step).toFixed(3)}% 100%`);
    pts.push(`${(i * step).toFixed(3)}% calc(100% - ${TOOTH_MM}mm)`);
  }
  return `polygon(${pts.join(",")})`;
}

const CSS = `
/*
 * The page is the desk the slip is lying on, and the slip is the document.
 *
 * Sized in millimetres rather than ems so that a long reference or a fifth
 * line of work cannot push the torn edge off the bottom of the page: the em
 * this sheet is set at is chosen for invoice tables, and this is not one.
 */
.sheet{background:${CREAM};align-items:center;justify-content:center;padding:10mm 0;font-size:3.5mm}
.slip{
  position:relative;width:92mm;max-height:277mm;overflow:hidden;background:${STOCK};
  clip-path:${tornEdge()};
  padding:8mm 7mm ${(TOOTH_MM + 3).toFixed(1)}mm;text-align:center;
}

.slip .top{display:flex;align-items:center;justify-content:center;gap:.5em}
.slip .logo{justify-content:center}
.slip .logo .biz{font-size:.92em;letter-spacing:-.01em}
.slip .meta{margin-top:.5em;font-size:.55em;line-height:1.5;color:${ink(0.45)}}

/* A row of dashes rather than a rule: the same mark a paper receipt uses to
   separate what it was from what it cost. */
.cut{height:0;margin:1.15em 0;border-top:1px dashed ${ink(0.22)}}

.stamp{
  display:inline-flex;align-items:center;gap:.45em;
  padding:.3em .75em;border-radius:999px;
  background:rgba(63,143,95,.12);color:${MOSS};
  font-size:.56em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
}
.stamp svg{width:.9em;height:.9em;fill:none;stroke:${MOSS};stroke-width:2.4;
stroke-linecap:round;stroke-linejoin:round}
.big{margin-top:.45em;font-family:${DISPLAY};font-size:1.95em;font-weight:800;
letter-spacing:-.045em;line-height:1.05;font-variant-numeric:tabular-nums}
.on{margin-top:.45em;font-size:.62em;color:${ink(0.55)}}

/* Label, leader, figure. The dots are what make a list of facts read as a
   receipt rather than as a form, and they lead the eye across a wide gap. */
.ln{display:flex;align-items:baseline;gap:.5em;font-size:.62em;padding:.22em 0;text-align:left}
.ln .k{color:${ink(0.55)};white-space:nowrap}
.ln .dots{flex:1;border-bottom:1px dotted ${ink(0.28)};transform:translateY(-.2em)}
.ln .v{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.ln .v.wrap{white-space:normal;overflow-wrap:anywhere;text-align:right;max-width:52%}
.ln.sum{margin-top:.5em;border-top:1px solid ${ink(0.3)};padding-top:.6em;font-size:.68em}
.ln.sum .k{color:${INK};font-weight:600}
.ln.owed .k,.ln.owed .v{color:${ink(0.55)};font-weight:600}

.what{margin-top:.9em;text-align:left}
.what .cap{text-align:left}
.foot{margin-top:1.1em;font-size:.6em;font-weight:600}
/* The link carries a 32-character token, so it is allowed to break anywhere
   rather than running off the edge of the paper. */
.foot .where{margin-top:.35em;font-size:.82em;font-weight:400;line-height:1.45;
color:${ink(0.45)};overflow-wrap:anywhere}
.foot .where b{font-weight:600;color:${INK}}
.slip .legal{margin-top:.9em;padding-bottom:1.1em;font-size:.5em;line-height:1.5;color:${ink(0.4)}}
.slip .made{display:flex;align-items:center;justify-content:center;gap:.35em;
margin-top:.75em;font-size:.55em;color:${ink(0.45)}}
/*
 * The support reference, under the slip rather than in the corner of the
 * page. Every other layout fills its sheet, so a corner is the quiet place;
 * here the corner is bare desk, and a code stranded on it reads as something
 * the printer did rather than something we put there.
 */
.ref{left:0;text-align:center;padding:0 0 6mm}
.slip .made svg{width:1.1em;height:1.1em;border-radius:50%}
`;

const TICK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;

/** Label, leader dots, figure. */
const line = (k: string, v: string, cls = ""): string =>
  `<p class="ln ${cls}"><span class="k">${k}</span><span class="dots"></span><span class="v${
    cls.includes("wrap") ? " wrap" : ""
  }">${v}</span></p>`;

export function renderReceiptHtml(d: DocumentData, opts: RenderOptions = {}): string {
  const r = d.receipt;

  /*
   * The figure on the face of it is what the client actually transferred —
   * grossed up by the processor's cut whenever fees are passed on. That is
   * the one they will look for on their bank statement, so it is the one in
   * the largest type.
   *
   * What is still owed is the invoice's own arithmetic, from the document's
   * running total. The two must not be mixed: a receipt that subtracts this
   * payment's fees from the invoice is a receipt that disagrees with the
   * invoice it was issued against.
   */
  const paid = r ? r.amountKobo : d.amountPaidKobo;
  const owed = owedKobo(d);

  const what = d.lines.length
    ? `<div class="what">
        ${d.lines
          .slice(0, 6)
          .map((l) => line(esc(l.description), money(l.amountKobo), "wrap"))
          .join("")}
        ${d.lines.length > 6 ? line(`and ${d.lines.length - 6} more`, "") : ""}
       </div>`
    : "";

  const body = `<div class="slip">
  <div class="top">${biz(d)}</div>
  ${bizMeta(d, ["address", "email", "tin"]) ? `<p class="meta">${bizMeta(d, ["address", "email", "tin"])}</p>` : ""}

  <div class="cut"></div>

  <p class="stamp">${TICK}Paid</p>
  <p class="big">${money(paid)}</p>
  ${r ? `<p class="on">${when(r.paidOn)}</p>` : ""}

  <div class="cut"></div>

  ${r ? line("Receipt", `#${r.number}`) : ""}
  ${d.number === null ? "" : line("Invoice", `#${d.number}`)}
  ${line("Paid by", esc(d.clientName), "wrap")}
  ${r ? line("Method", esc(methodWords(r.method))) : ""}
  ${r ? line("Reference", esc(r.reference), "wrap") : ""}

  ${what}

  ${
    /*
     * The invoice's own arithmetic, and only when this payment did not settle
     * the whole of it. On a receipt that clears the balance, "paid ₦215,000
     * of ₦215,000, ₦0 still owed" is three lines to say what the figure above
     * already says.
     */
    owed > 0
      ? `<div class="what">
           ${line(`${d.variant === "quote" ? "Quote" : "Invoice"} total`, money(d.totalKobo), "sum")}
           ${line("Still owed", money(owed), "owed")}
         </div>`
      : ""
  }

  <div class="cut"></div>

  <div class="foot">
    <p>Thank you for the payment.</p>
    ${d.publicUrl ? `<p class="where">See it any time at <b>${esc(shortUrl(d.publicUrl))}</b></p>` : ""}
  </div>

  ${d.showMadeWith ? madeWith(d) : ""}
  ${legal(d)}
</div>`;

  return sheet(d, opts, { css: CSS, body });
}
