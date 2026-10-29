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
 * anything else on it, on a panel of night green and soft marigold light. In
 * Onest, the brand's face since 29 October 2026, so it is recognisably from
 * the same product as balans.ng and the chat — a different kind of document,
 * not a different brand.
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
  ink,
  legal,
  logoIsSquare,
  madeWith,
  methodWords,
  money,
  owedKobo,
  shortUrl,
  when,
  CREAM,
  INK,
  type RenderOptions,
} from "./kit.ts";
import { sheet } from "./kit.ts";
import type { DocumentData } from "./template.ts";
import { FONT } from "./fonts.ts";

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
const TOOTH_MM = 4;
const TEETH = 40;

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
 *
 * The full width of the page, less a margin. It was a 92mm till slip in the
 * middle of an A4 sheet, which is the right shape on a desk and the wrong one
 * on a phone: opened in WhatsApp the page is scaled to the screen, and a slip
 * a third of its width came out as small print in a lot of empty cream.
 */
.sheet{background:${CREAM};align-items:center;justify-content:center;padding:14mm 16mm;font-size:5.1mm;
  font-family:${FONT.brand}}
.slip{
  position:relative;width:100%;max-height:269mm;overflow:hidden;background:${STOCK};
  clip-path:${tornEdge()};
  padding:12mm 14mm ${(TOOTH_MM + 5).toFixed(1)}mm;text-align:center;
  /* Onest sets taller than the face it replaced; this keeps the legal lines
     above the torn edge. */
  font-size:.92em;
}

.slip .top{display:flex;align-items:center;justify-content:center;gap:.5em}
.slip .logo{justify-content:center}
.slip .logo.stack{flex-direction:column;gap:.55em}
.slip .logo.stack img{height:3.4em;max-width:12em;object-position:center}
.slip .logo img.sq{border-radius:22%}
.slip .logo .biz{font-size:.92em;letter-spacing:-.01em}
.slip .meta{margin-top:.5em;font-size:.55em;line-height:1.5;color:${ink(0.45)}}
/*
 * The moment itself, in the brand's own light (29 October 2026): night green
 * with one soft marigold light from the corner, the tick, the word and the
 * figure in cream. Everything after it is paper, to be filed.
 */
.hero{margin-top:1em;padding:1.15em 1em 1.05em;border-radius:.8em;color:${CREAM};
  background:radial-gradient(120% 95% at 100% 0%,rgba(245,184,46,.34),rgba(245,184,46,.09) 42%,rgba(245,184,46,0) 68%),#08130F}
.tick{display:grid;place-items:center;width:2.1em;height:2.1em;margin:0 auto .6em;border-radius:50%;
  background:linear-gradient(180deg,#FFD877,#F5B82E)}
.tick svg{width:1.05em;height:1.05em;fill:none;stroke:${INK};stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.hero .head{font-size:.74em;font-weight:400;color:rgba(246,241,231,.66)}
/* The facts, each list on a soft panel of its own. */
.panel{margin-top:.7em;padding:.6em .85em;border-radius:.65em;background:${ink(0.035)}}
.panel .cap{margin:.2em 0 .25em;text-align:left}

/* A row of dashes rather than a rule: the same mark a paper receipt uses to
   separate what it was from what it cost. */
.cut{height:0;margin:1.15em 0;border-top:1px dashed ${ink(0.22)}}

.stamp{
  display:inline-flex;align-items:center;gap:.4em;margin-top:.7em;
  padding:.32em .85em;border-radius:999px;
  background:linear-gradient(180deg,#FFD877,#F5B82E);color:${INK};
  font-size:.58em;font-weight:500;
}
.stamp svg{width:.9em;height:.9em;fill:none;stroke:${INK};stroke-width:2.4;
stroke-linecap:round;stroke-linejoin:round}
.big{margin-top:.3em;font-size:2.2em;font-weight:500;
letter-spacing:-.05em;line-height:1.05;font-variant-numeric:tabular-nums}
.on{margin-top:.45em;font-size:.62em;color:rgba(246,241,231,.62)}

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

.what{text-align:left}
.what .cap{text-align:left}
.foot{margin-top:1.1em;font-size:.62em;font-weight:500}
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

  /*
   * A logo stands above the name rather than beside it, centred like the
   * rest of the slip; a square one gets rounded corners, the way an app icon
   * or a badge is meant to be seen.
   */
  const head = d.logoDataUri
    ? `<div class="logo stack"><img${logoIsSquare(d.logoDataUri) ? ' class="sq"' : ""} src="${d.logoDataUri}" alt=""><p class="biz">${esc(d.businessName)}</p></div>`
    : biz(d);

  const body = `<div class="slip">
  <div class="top">${head}</div>
  ${bizMeta(d, ["address", "email", "tin"]) ? `<p class="meta">${bizMeta(d, ["address", "email", "tin"])}</p>` : ""}

  <div class="hero">
    <span class="tick">${TICK}</span>
    <p class="head">Payment received</p>
    <p class="big">${money(paid)}</p>
    ${r ? `<p class="on">${when(r.paidOn)}</p>` : ""}
    ${
      // Nothing watched this money arrive; the sender said it did. The client
      // is owed knowing which kind of receipt they are holding.
      r && r.method === "OFFLINE" ? `<p class="on">Payment received outside Balans, confirmed by ${esc(d.businessName)}</p>` : ""
    }
    <p class="stamp">${TICK}Paid</p>
  </div>

  <div class="panel">
    ${r ? line("Receipt", `#${r.number}`) : ""}
    ${d.number === null ? "" : line("Invoice", `#${d.number}`)}
    ${line("Paid by", esc(d.clientName), "wrap")}
    ${r ? line("Method", esc(methodWords(r.method))) : ""}
    ${r ? line("Reference", esc(r.reference), "wrap") : ""}
  </div>

  ${what ? `<div class="panel">${what}</div>` : ""}

  ${
    /*
     * The invoice's own arithmetic, and only when this payment did not settle
     * the whole of it. On a receipt that clears the balance, "paid ₦215,000
     * of ₦215,000, ₦0 still owed" is three lines to say what the figure above
     * already says.
     */
    owed > 0
      ? `<div class="panel what">
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

  return sheet(d, opts, { css: CSS, body, fonts: ["brand"] });
}
