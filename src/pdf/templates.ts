/**
 * The invoice layouts (PRD F24, and the design system PRD's template set).
 *
 * Eight of them: two on Free, six on Pro. They exist as React components in
 * the web repo, where they are captured to WebP for the landing page. These
 * are the same designs rebuilt as plain HTML, because the renderer here has no
 * framework and a PDF must not depend on one.
 *
 * Everything is sized in `em`, exactly as the originals are, so one font-size
 * on the sheet scales the whole document. That is what lets the same markup
 * serve an A4 page and a thumbnail in the picker without a second copy to keep
 * in step.
 *
 * Colour never carries structure. The design system's seventh acceptance
 * criterion is that a document stays legible photocopied in black and white,
 * so the layouts lean on ink blocks, rules and weight instead.
 */

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { esc } from "../documents/page.ts";
import { renderDocumentHtml, type DocumentData } from "./template.ts";

export type TemplateId =
  | "classic"
  | "wordmark"
  | "monolith"
  | "editorial"
  | "atelier"
  | "statement"
  | "ledger"
  | "folio";

export type TemplateSpec = {
  id: TemplateId;
  name: string;
  pro: boolean;
  /** One line, as the picker shows it. */
  blurb: string;
  /** Not every layout is ported yet; the picker only offers the ones that are. */
  ready: boolean;
};

/** Matches the web repo's list, so the picker and the landing page agree. */
export const TEMPLATES: TemplateSpec[] = [
  {
    id: "classic",
    name: "Classic",
    pro: false,
    blurb: "Your name first, the amount stated early, nothing to puzzle over.",
    ready: true,
  },
  {
    id: "wordmark",
    name: "Wordmark",
    pro: false,
    blurb: "The word set large, the details down a rail. Reads well in black and white.",
    ready: true,
  },
  {
    id: "statement",
    name: "Statement",
    pro: true,
    blurb: "The amount due on an ink card at the top, with the link to pay beside it.",
    ready: true,
  },
  {
    id: "ledger",
    name: "Ledger",
    pro: true,
    blurb: "Numbered sections on a hard grid, total bottom right. One an accountant thanks you for.",
    ready: true,
  },
  {
    id: "monolith",
    name: "Monolith",
    pro: true,
    blurb: "A full-height ink spine with the word turned up it. Unmistakable across a desk.",
    ready: true,
  },
  {
    id: "editorial",
    name: "Editorial",
    pro: true,
    blurb: "The work set as the headline, like the cover of a report.",
    ready: true,
  },
  {
    id: "atelier",
    name: "Atelier",
    pro: true,
    blurb: "Centred, serif, with a monogram and dotted leaders. For studios that charge for taste.",
    ready: true,
  },
  {
    id: "folio",
    name: "Folio",
    pro: true,
    blurb: "A sand margin holding the facts, the work on clean paper beside it.",
    ready: true,
  },
];

export const DEFAULT_TEMPLATE: TemplateId = "classic";

export const templateById = (id: string | null | undefined): TemplateSpec =>
  TEMPLATES.find((t) => t.id === id && t.ready) ??
  TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE)!;

/** What a user may actually choose, given their plan. */
export const availableTo = (plan: "free" | "pro"): TemplateSpec[] =>
  TEMPLATES.filter((t) => t.ready && (plan === "pro" || !t.pro));

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

const INK = "#10231C";
const MARIGOLD = "#F5B82E";
const SAND = "#E9E1D0";
const CREAM = "#F6F1E7";

/** The coin, drawn rather than fetched, so a render never waits on a file. */
const coin = (size: string): string =>
  `<svg viewBox="0 0 120 120" style="width:${size};height:${size};display:block" aria-hidden="true">
     <circle cx="60" cy="60" r="60" fill="${MARIGOLD}"/>
     <rect x="38" y="18" width="15" height="82" rx="3" fill="${INK}"/>
     <circle cx="68" cy="74" r="19" fill="none" stroke="${INK}" stroke-width="14"/>
     <rect x="25" y="25" width="41" height="8" rx="2" fill="${INK}"/>
     <rect x="25" y="38" width="41" height="8" rx="2" fill="${INK}"/>
   </svg>`;

const money = (kobo: number) => formatNaira(kobo);
const when = (d: Civil | null) => (d ? formatFriendly(d) : "—");

/** The line items, as a table. Shared because every layout lists the same work. */
function itemRows(d: DocumentData, opts: { showQty?: boolean } = {}): string {
  return d.lines
    .map(
      (l) => `<tr>
        <td class="desc">${esc(l.description)}</td>
        ${opts.showQty === false ? "" : `<td class="c">${l.qty === 1 ? "1" : l.qty}</td>`}
        <td class="r">${money(l.amountKobo)}</td>
      </tr>`,
    )
    .join("");
}

/** Section 12's two lines, on everything a client sees. */
const legal = (d: DocumentData): string =>
  `${esc(d.legalLines[0])}<br>${esc(d.legalLines[1])}`;

const madeWith = (d: DocumentData): string =>
  d.showMadeWith ? `<div class="made">Made with Balans &middot; balans.ng</div>` : "";

/* -------------------------------------------------------------------------- */
/* Base stylesheet                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The parts every layout shares.
 *
 * A sheet is `aspect-ratio` and `em`, not millimetres, so the same markup is an
 * A4 page at one font-size and a picker thumbnail at another.
 */
const BASE = `
@page { size: A4; margin: 0 }
*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;color:${INK};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{
  width:210mm;height:297mm;background:#fff;position:relative;overflow:hidden;
  display:flex;flex-direction:column;
  font-family:"Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif;
  font-size:4.6mm;line-height:1.45;
}
.cap{font-size:.56em;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:rgba(16,35,28,.42)}
.val{font-size:.84em;font-weight:600;margin-top:.15em}
table{width:100%;border-collapse:collapse}
td,th{vertical-align:top}
td.c,th.c{text-align:center}
td.r,th.r{text-align:right;white-space:nowrap}
td.desc{padding-right:1.4em}
.foot{margin-top:auto;font-size:.52em;line-height:1.6;color:rgba(16,35,28,.45)}
.foot .made{margin-top:.5em;color:rgba(16,35,28,.34)}
.watermark{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);
  font-size:5.2em;font-weight:800;letter-spacing:.06em;
  color:rgba(16,35,28,.07);white-space:nowrap;
}
`;

const page = (css: string, body: string, d: DocumentData): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>${BASE}${css}</style></head>
<body><div class="sheet">
${d.variant === "sample" ? `<div class="watermark">SAMPLE</div>` : ""}
${body}
</div></body></html>`;

const TITLE: Record<DocumentData["variant"], string> = {
  invoice: "INVOICE",
  quote: "QUOTE",
  receipt: "RECEIPT",
  sample: "INVOICE",
};

/* -------------------------------------------------------------------------- */
/* Wordmark (Free)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The kind set large, the facts down a rail on the left.
 *
 * No colour blocks at all: it is the layout that survives a fax machine, which
 * is still how some Nigerian offices receive an invoice.
 */
function wordmark(d: DocumentData): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:3.6em 3.9em 3em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:2em}
.kind{font-size:4.1em;line-height:.9;font-weight:800;letter-spacing:-.04em}
.brand{text-align:right}
.brand .biz{font-size:1.05em;font-weight:700;letter-spacing:-.02em}
.brand .meta{margin-top:.5em;font-size:.6em;color:rgba(16,35,28,.5);line-height:1.6}
.body{margin-top:3.2em;display:flex;gap:3em;flex:1}
.rail{width:13em;flex:none;display:flex;flex-direction:column;gap:1.7em}
.work{flex:1;min-width:0;border-left:1px solid rgba(16,35,28,.14);padding-left:2.8em}
thead th{text-align:left;padding-bottom:.7em;border-bottom:1px solid ${INK}}
tbody td{padding:.95em 0;border-bottom:1px solid rgba(16,35,28,.09);font-size:.86em}
.totals{margin-top:1.6em;display:flex;justify-content:flex-end}
.totals .box{min-width:11em}
.trow{display:flex;justify-content:space-between;gap:2em;font-size:.8em;padding:.3em 0;color:rgba(16,35,28,.66)}
.trow.big{margin-top:.6em;padding-top:.7em;border-top:2px solid ${INK};font-size:1.15em;font-weight:800;color:${INK}}
.tail{margin-top:2.4em;padding-top:1.1em;border-top:1px solid rgba(16,35,28,.14)}
`;

  const body = `<div class="wrap">
  <div class="top">
    <div class="kind">${TITLE[d.variant]}</div>
    <div class="brand">
      <div class="biz">${esc(d.businessName)}</div>
      <div class="meta">
        ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
        ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
        ${d.businessTin ? `TIN ${esc(d.businessTin)}` : ""}
      </div>
    </div>
  </div>

  <div class="body">
    <div class="rail">
      <div><div class="cap">Billed to</div><div class="val">${esc(d.clientName)}</div></div>
      ${d.number === null ? "" : `<div><div class="cap">Invoice no.</div><div class="val">${d.number}</div></div>`}
      <div><div class="cap">Issued</div><div class="val">${when(d.issueDate)}</div></div>
      <div><div class="cap">${d.variant === "quote" ? "Valid until" : "Due"}</div><div class="val">${when(d.dueDate)}</div></div>
    </div>

    <div class="work">
      <table>
        <thead><tr><th class="cap">Description</th><th class="cap c">Qty</th><th class="cap r">Amount</th></tr></thead>
        <tbody>${itemRows(d)}</tbody>
      </table>
      <div class="totals"><div class="box">
        ${d.vatKobo > 0 ? `<div class="trow"><span>Subtotal</span><span>${money(d.subtotalKobo)}</span></div>
        <div class="trow"><span>VAT</span><span>${money(d.vatKobo)}</span></div>` : ""}
        <div class="trow big"><span>Total</span><span>${money(d.totalKobo)}</span></div>
      </div></div>
      ${d.publicUrl && d.variant !== "receipt" ? `<div class="tail"><div class="cap">Pay online</div><div style="font-size:.74em;margin-top:.35em;word-break:break-all">${esc(d.publicUrl)}</div></div>` : ""}
    </div>
  </div>

  <div class="foot">${legal(d)}${madeWith(d)}</div>
</div>`;

  return page(css, body, d);
}

/* -------------------------------------------------------------------------- */
/* Statement (Pro)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The amount due on an ink card at the top, with the link beside it.
 *
 * Built for the one job an invoice has: nobody should have to hunt for what
 * they owe or where to pay it.
 */
function statement(d: DocumentData): string {
  const owed = d.totalKobo - d.amountPaidKobo;

  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:3.4em 3.6em 3em}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:2em}
.biz{font-size:1.35em;font-weight:700;letter-spacing:-.02em}
.meta{margin-top:.45em;font-size:.6em;color:rgba(16,35,28,.5);line-height:1.6}
.kind{font-size:.62em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:rgba(16,35,28,.45);text-align:right}
.kind .no{display:block;margin-top:.4em;font-size:1.5em;letter-spacing:0;color:${INK}}
.card{
  margin-top:2.4em;background:${INK};color:${CREAM};border-radius:.5em;
  padding:1.8em 2em;display:flex;align-items:center;justify-content:space-between;gap:2em;
}
.card .lbl{font-size:.58em;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.62}
.card .amt{font-size:2.5em;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-top:.12em}
.card .pay{text-align:right;max-width:17em}
.card .pay .url{margin-top:.3em;font-size:.62em;word-break:break-all;opacity:.85}
.parties{margin-top:2.4em;display:flex;gap:3em}
.parties>div{flex:1}
table{margin-top:2.4em}
thead th{text-align:left;padding-bottom:.7em;border-bottom:1px solid rgba(16,35,28,.2)}
tbody td{padding:.9em 0;border-bottom:1px solid rgba(16,35,28,.08);font-size:.86em}
.totals{margin-top:1.5em;margin-left:auto;width:15em}
.trow{display:flex;justify-content:space-between;font-size:.82em;padding:.3em 0;color:rgba(16,35,28,.66)}
.trow.big{margin-top:.5em;padding-top:.7em;border-top:1.5px solid ${INK};font-size:1.1em;font-weight:800;color:${INK}}
.notes{margin-top:2em;padding:1.1em 1.3em;background:${CREAM};border-radius:.4em;font-size:.72em;color:rgba(16,35,28,.72);white-space:pre-wrap}
`;

  const body = `<div class="wrap">
  <div class="head">
    <div>
      <div class="biz">${esc(d.businessName)}</div>
      <div class="meta">
        ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
        ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
        ${d.businessTin ? `TIN ${esc(d.businessTin)}` : ""}
      </div>
    </div>
    <div class="kind">${TITLE[d.variant]}${d.number === null ? "" : `<span class="no">#${d.number}</span>`}</div>
  </div>

  <div class="card">
    <div>
      <div class="lbl">${d.variant === "receipt" ? "Amount paid" : "Amount due"}</div>
      <div class="amt">${money(d.variant === "receipt" ? d.amountPaidKobo : owed)}</div>
    </div>
    ${
      d.publicUrl && d.variant !== "receipt"
        ? `<div class="pay"><div class="lbl">Pay online</div><div class="url">${esc(d.publicUrl)}</div></div>`
        : `<div class="pay"><div class="lbl">${d.variant === "quote" ? "Valid until" : "Due"}</div><div class="url">${when(d.dueDate)}</div></div>`
    }
  </div>

  <div class="parties">
    <div><div class="cap">Billed to</div><div class="val">${esc(d.clientName)}</div>
      ${d.clientEmail ? `<div style="font-size:.66em;color:rgba(16,35,28,.5);margin-top:.2em">${esc(d.clientEmail)}</div>` : ""}</div>
    <div><div class="cap">Issued</div><div class="val">${when(d.issueDate)}</div></div>
    <div><div class="cap">${d.variant === "quote" ? "Valid until" : "Due"}</div><div class="val">${when(d.dueDate)}</div></div>
  </div>

  <table>
    <thead><tr><th class="cap">Description</th><th class="cap c">Qty</th><th class="cap r">Amount</th></tr></thead>
    <tbody>${itemRows(d)}</tbody>
  </table>

  <div class="totals">
    ${d.vatKobo > 0 ? `<div class="trow"><span>Subtotal</span><span>${money(d.subtotalKobo)}</span></div>
    <div class="trow"><span>VAT ${d.vatPercent ?? ""}%</span><span>${money(d.vatKobo)}</span></div>` : ""}
    <div class="trow big"><span>Total</span><span>${money(d.totalKobo)}</span></div>
  </div>

  ${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}
  <div class="foot">${legal(d)}${madeWith(d)}</div>
</div>`;

  return page(css, body, d);
}

/* -------------------------------------------------------------------------- */
/* Ledger (Pro)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Numbered sections on a hard grid, total bottom right.
 *
 * The accountant's one: every fact has a numbered place, so a query about an
 * invoice can name the section it is about.
 */
function ledger(d: DocumentData): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:3.2em 3.4em 2.8em}
.rule{border-top:2px solid ${INK}}
.thin{border-top:1px solid rgba(16,35,28,.16)}
.masthead{display:flex;align-items:baseline;justify-content:space-between;gap:2em;padding-bottom:1em}
.biz{font-size:1.25em;font-weight:700;letter-spacing:-.02em}
.kind{font-size:.62em;font-weight:700;letter-spacing:.18em;text-transform:uppercase}
.grid{display:flex;flex-wrap:wrap}
.cell{width:25%;padding:1.1em 1em 1.1em 0}
.cell .n{font-size:.52em;font-weight:700;color:rgba(16,35,28,.3);letter-spacing:.1em}
.cell .k{margin-top:.25em;font-size:.55em;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:rgba(16,35,28,.45)}
.cell .v{margin-top:.25em;font-size:.82em;font-weight:600}
.sec{margin-top:1.6em;font-size:.55em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(16,35,28,.45)}
table{margin-top:.8em}
thead th{text-align:left;padding-bottom:.6em;border-bottom:1px solid rgba(16,35,28,.2);font-size:.55em;letter-spacing:.09em;text-transform:uppercase;color:rgba(16,35,28,.45);font-weight:600}
tbody td{padding:.85em 0;border-bottom:1px solid rgba(16,35,28,.08);font-size:.84em}
.totals{margin-top:1.4em;display:flex;justify-content:flex-end}
.totals .box{min-width:13em}
.trow{display:flex;justify-content:space-between;font-size:.8em;padding:.32em 0;color:rgba(16,35,28,.66)}
.trow.big{margin-top:.5em;padding-top:.65em;border-top:2px solid ${INK};font-size:1.12em;font-weight:800;color:${INK}}
.paybar{margin-top:1.6em;padding:1em 1.2em;background:${SAND};border-radius:.3em;font-size:.68em}
.paybar .u{margin-top:.2em;word-break:break-all;font-weight:600}
`;

  const cells = [
    ["01", "Billed to", esc(d.clientName)],
    ["02", d.variant === "quote" ? "Quote no." : "Invoice no.", d.number === null ? "—" : String(d.number)],
    ["03", "Issued", when(d.issueDate)],
    ["04", d.variant === "quote" ? "Valid until" : "Due", when(d.dueDate)],
  ]
    .map(
      ([n, k, v]) => `<div class="cell"><div class="n">${n}</div><div class="k">${k}</div><div class="v">${v}</div></div>`,
    )
    .join("");

  const body = `<div class="wrap">
  <div class="masthead">
    <div class="biz">${esc(d.businessName)}</div>
    <div class="kind">${TITLE[d.variant]}</div>
  </div>
  <div class="rule"></div>

  <div class="grid">${cells}</div>
  <div class="thin"></div>

  <div class="sec">05 &nbsp; Work</div>
  <table>
    <thead><tr><th>Description</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
    <tbody>${itemRows(d)}</tbody>
  </table>

  <div class="totals"><div class="box">
    ${d.vatKobo > 0 ? `<div class="trow"><span>Subtotal</span><span>${money(d.subtotalKobo)}</span></div>
    <div class="trow"><span>VAT ${d.vatPercent ?? ""}%</span><span>${money(d.vatKobo)}</span></div>` : ""}
    <div class="trow big"><span>Total</span><span>${money(d.totalKobo)}</span></div>
  </div></div>

  ${
    d.publicUrl && d.variant !== "receipt"
      ? `<div class="paybar"><div class="cap">06 &nbsp; Pay online</div><div class="u">${esc(d.publicUrl)}</div></div>`
      : ""
  }

  <div class="foot">${legal(d)}${madeWith(d)}</div>
</div>`;

  return page(css, body, d);
}

/* -------------------------------------------------------------------------- */

/** Classic is the layout the product shipped with; it lives in template.ts. */
/* -------------------------------------------------------------------------- */
/* The four remaining Pro layouts                                             */
/* -------------------------------------------------------------------------- */

/**
 * Initials for a monogram, from the business name.
 *
 * Two letters at most: three in a ring stops being a mark and starts being an
 * abbreviation nobody asked for.
 */
function initials(name: string): string {
  const words = name
    .split(/[\s&,.\-]+/)
    .filter((w) => /[A-Za-z]/.test(w))
    .slice(0, 2);
  return words.map((w) => w[0]!.toUpperCase()).join("") || "—";
}

/**
 * The line a layout sets the document under.
 *
 * The marketing sheets carried a made-up project name. A real invoice has no
 * such field, and inventing one would put words on a document the user never
 * wrote — so this uses what is actually there.
 *
 * One line item is the job, and naming it reads exactly right. Several are
 * not: billing the first of three as though it were the whole job misstates
 * what the client is paying for, so those get the client's name instead, which
 * is true of every invoice ever written.
 */
const headline = (d: DocumentData): string =>
  d.lines.length === 1 ? d.lines[0]!.description : d.clientName;

/**
 * The link, as its own block.
 *
 * Never the bank account. It is on none of these layouts on purpose: an
 * invoice travels further than the person it was sent to, and the account
 * number is the one thing on it that cannot be changed afterwards.
 */
const payBlock = (d: DocumentData, label = "Pay online"): string =>
  d.publicUrl && d.variant !== "receipt"
    ? `<div><div class="cap">${label}</div><div class="url">${esc(d.publicUrl)}</div></div>`
    : "";

/** Subtotal and VAT, above a stated total. Omitted entirely when VAT is zero. */
const smallSums = (d: DocumentData): string =>
  d.vatKobo > 0
    ? `<div class="trow"><span>Subtotal</span><span>${money(d.subtotalKobo)}</span></div>
       <div class="trow"><span>VAT${d.vatPercent ? ` ${d.vatPercent}%` : ""}</span><span>${money(d.vatKobo)}</span></div>`
    : "";

const dueLabel = (d: DocumentData): string => (d.variant === "quote" ? "Valid until" : "Due");
const totalLabel = (d: DocumentData): string => (d.variant === "quote" ? "Quoted" : "Total due");

/* -------------------------------------------------------------------------- */

/**
 * Monolith — a full-height ink spine with the word turned up it.
 *
 * The spine is the whole idea: one heavy block against a lot of white, so the
 * document is recognisable face down on a desk. Nothing is printed on it but
 * the word and the number, and nothing of ours — a Balans mark up the side of
 * somebody's invoice reads as their mark, which it is not.
 */
function monolith(d: DocumentData): string {
  const css = `
.row{flex:1;display:flex;min-height:0}
.spine{
  width:3.4em;flex:none;background:${INK};color:${CREAM};
  display:flex;flex-direction:column;align-items:center;justify-content:space-between;
  padding:2.2em 0 1.8em;
}
.spine .word{
  writing-mode:vertical-rl;transform:rotate(180deg);
  font-size:1.7em;font-weight:800;letter-spacing:.2em;line-height:1;
}
.spine .no{writing-mode:vertical-rl;transform:rotate(180deg);font-size:.62em;letter-spacing:.24em;opacity:.6}
.main{flex:1;min-width:0;display:flex;flex-direction:column;padding:2.2em 2.6em 1.9em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1.6em}
.dates{font-size:.62em;line-height:1.7;color:rgba(16,35,28,.5)}
.dates b{color:${INK};font-weight:600}
.brand{text-align:right;min-width:0}
.brand .biz{font-size:1.05em;font-weight:800;letter-spacing:.05em;text-transform:uppercase;line-height:1.15}
.brand .meta{margin-top:.6em;font-size:.6em;line-height:1.6;color:rgba(16,35,28,.5)}
.facts{margin-top:2em;display:flex;gap:2.4em;border-top:1px solid rgba(16,35,28,.14);padding-top:1.3em}
.facts .who{font-size:.62em;margin-top:.2em;color:rgba(16,35,28,.5)}
table{margin-top:1.8em}
thead th{background:${INK};color:${CREAM};text-align:left;padding:.85em 1.1em;
font-size:.58em;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
thead th.r{text-align:right}
thead th.c{text-align:center}
tbody td{padding:.9em 1.1em;border-bottom:1px solid rgba(16,35,28,.1);font-size:.84em}
.sums{margin-top:1.7em;display:flex;align-items:flex-end;justify-content:space-between;gap:2em}
.due .amt{font-size:2.1em;font-weight:800;letter-spacing:-.04em;line-height:1;margin-top:.1em}
.box{width:13em}
.trow{display:flex;justify-content:space-between;font-size:.72em;padding:.28em 0;color:rgba(16,35,28,.55)}
.trow.big{margin-top:.45em;padding-top:.5em;border-top:1px solid rgba(16,35,28,.25);font-weight:700;color:${INK}}
.tail{margin-top:auto;padding-top:1.8em;display:flex;gap:2.4em;align-items:flex-end;justify-content:space-between}
.url{margin-top:.35em;font-size:.68em;word-break:break-all}
.tail .foot{margin:0;text-align:right;max-width:21em}
`;

  const body = `<div class="row">
  <div class="spine">
    <div class="word">${TITLE[d.variant]}</div>
    ${d.number === null ? "<div></div>" : `<div class="no">No. ${d.number}</div>`}
  </div>

  <div class="main">
    <div class="top">
      <div class="dates">
        ${d.issueDate ? `Issued <b>${when(d.issueDate)}</b><br>` : ""}
        ${d.dueDate ? `${dueLabel(d)} <b>${when(d.dueDate)}</b>` : ""}
      </div>
      <div class="brand">
        <div class="biz">${esc(d.businessName)}</div>
        <div class="meta">
          ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
          ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
          ${d.businessTin ? `TIN ${esc(d.businessTin)}` : ""}
        </div>
      </div>
    </div>

    <div class="facts">
      <div style="flex:1;min-width:0">
        <div class="cap">Billed to</div>
        <div class="val">${esc(d.clientName)}</div>
        ${d.clientEmail ? `<div class="who">${esc(d.clientEmail)}</div>` : ""}
      </div>
      ${
        d.number === null
          ? ""
          : `<div style="min-width:0"><div class="cap">${
              d.variant === "quote" ? "Quote" : "Invoice"
            } no.</div><div class="val">${d.number}</div></div>`
      }
    </div>

    <table>
      <thead><tr><th>Description</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
      <tbody>${itemRows(d)}</tbody>
    </table>

    <div class="sums">
      <div class="due">
        <div class="cap">${totalLabel(d)}</div>
        <div class="amt">${money(d.totalKobo)}</div>
      </div>
      <div class="box">
        ${smallSums(d)}
        <div class="trow big"><span>Total</span><span>${money(d.totalKobo)}</span></div>
      </div>
    </div>

    <div class="tail">
      ${payBlock(d)}
      <div class="foot">${legal(d)}${madeWith(d)}</div>
    </div>
  </div>
</div>`;

  return page(css, body, d);
}

/**
 * Editorial — the work set as the headline, like the cover of a report.
 *
 * The largest thing on the page is what the invoice is for, not the word
 * "invoice", which is the one fact the client already knows.
 */
function editorial(d: DocumentData): string {
  /** Whether the headline names the work rather than falling back to the client. */
  const namedWork = d.lines.length === 1;

  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:2.5em 2.9em 2em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1.6em}
.biz{font-size:.85em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;line-height:1.2}
.bizmeta{margin-top:.4em;font-size:.56em;line-height:1.6;color:rgba(16,35,28,.45)}
.kindwrap{text-align:right;flex:none}
.kind{font-size:.66em;font-weight:800;letter-spacing:.4em;text-transform:uppercase}
.kind .no{display:block;margin-top:.5em;font-size:.88em;letter-spacing:0;font-weight:500;color:rgba(16,35,28,.5)}
.lede{margin-top:1.9em}
.lede .h{font-size:2.4em;font-weight:800;letter-spacing:-.05em;line-height:.98;margin-top:.12em}
.lede .h .dot{color:${MARIGOLD}}
.strip{margin-top:1.5em;display:flex;gap:1.6em;
border-top:1px solid rgba(16,35,28,.14);border-bottom:1px solid rgba(16,35,28,.14);padding:1em 0}
.strip>div{min-width:0}
table{margin-top:1.6em}
thead th{text-align:left;padding-bottom:.65em;border-bottom:1.5px solid ${INK};
font-size:.58em;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(16,35,28,.5)}
thead th.r{text-align:right}
thead th.c{text-align:center}
tbody td{padding:.85em 0;border-bottom:1px solid rgba(16,35,28,.09);font-size:.84em}
.sums{margin-top:1.5em;display:flex;align-items:flex-end;justify-content:space-between;gap:2em}
.due .amt{font-size:2em;font-weight:800;letter-spacing:-.04em;line-height:1;margin-top:.1em}
.box{width:12.5em}
.trow{display:flex;justify-content:space-between;font-size:.72em;padding:.28em 0;color:rgba(16,35,28,.55)}
.trow.big{margin-top:.45em;padding-top:.5em;border-top:1px solid rgba(16,35,28,.25);font-weight:700;color:${INK}}
.notes{margin-top:1.4em;font-size:.68em;line-height:1.6;color:rgba(16,35,28,.6);white-space:pre-wrap}
.tail{margin-top:auto;padding-top:1.6em;display:flex;align-items:flex-end;justify-content:space-between;gap:2em}
.url{margin-top:.35em;font-size:.68em;word-break:break-all}
.tail .foot{margin:0;text-align:right;max-width:21em}
`;

  const body = `<div class="wrap">
  <div class="top">
    <div>
      <div class="biz">${esc(d.businessName)}</div>
      <div class="bizmeta">
        ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
        ${d.businessAddress ? `${esc(d.businessAddress)}` : ""}
      </div>
    </div>
    <div class="kindwrap">
      <div class="kind">${TITLE[d.variant]}${
        d.number === null ? "" : `<span class="no">No. ${d.number}</span>`
      }</div>
    </div>
  </div>

  <div class="lede">
    <div class="cap">${namedWork ? (d.variant === "quote" ? "Quoted for" : "Work") : "Billed to"}</div>
    <div class="h">${esc(headline(d))}<span class="dot">.</span></div>
  </div>

  <div class="strip">
    ${
      // Only when the headline is not already the client, so the name is not
      // set twice on the same page.
      namedWork
        ? `<div style="flex:1.4"><div class="cap">Billed to</div><div class="val">${esc(d.clientName)}</div></div>`
        : ""
    }
    <div style="flex:1"><div class="cap">Issued</div><div class="val">${when(d.issueDate)}</div></div>
    <div style="flex:1"><div class="cap">${dueLabel(d)}</div><div class="val">${when(d.dueDate)}</div></div>
    ${namedWork ? "" : `<div style="flex:1.4"></div>`}
  </div>

  <table>
    <thead><tr><th>Description</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
    <tbody>${itemRows(d)}</tbody>
  </table>

  <div class="sums">
    <div class="due">
      <div class="cap">${totalLabel(d)}</div>
      <div class="amt">${money(d.totalKobo)}</div>
    </div>
    <div class="box">
      ${smallSums(d)}
      <div class="trow big"><span>Total</span><span>${money(d.totalKobo)}</span></div>
    </div>
  </div>

  ${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}

  <div class="tail">
    ${payBlock(d)}
    <div class="foot">${legal(d)}${madeWith(d)}</div>
  </div>
</div>`;

  return page(css, body, d);
}

/**
 * Atelier — centred, serif, with a monogram and dotted leaders.
 *
 * Set like a menu rather than a spreadsheet. The monogram is drawn from the
 * business name, so it is theirs. There is no signature: the marketing sheet
 * had one, and putting a drawn hand on a real document we were never given
 * would be a forgery of the user's own mark.
 */
function atelier(d: DocumentData): string {
  const css = `
.sheet{background:#fbf8f2}
.wrap{flex:1;display:flex;flex-direction:column;padding:2.7em 3.1em 2.2em;text-align:center}
.mono{
  width:2.6em;height:2.6em;margin:0 auto;border-radius:50%;
  border:1px solid rgba(16,35,28,.5);display:flex;align-items:center;justify-content:center;
  font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:1em;line-height:1;
}
.biz{margin-top:1em;font-size:.66em;font-weight:600;letter-spacing:.42em;text-transform:uppercase}
.bizmeta{margin-top:.55em;font-size:.56em;color:rgba(16,35,28,.45);line-height:1.6}
.rules{margin-top:1.4em;border-top:1px solid rgba(16,35,28,.2);border-bottom:1px solid rgba(16,35,28,.2);padding:.25em 0}
.rules .inner{border-top:1px solid rgba(16,35,28,.2);border-bottom:1px solid rgba(16,35,28,.2);padding:.85em 0}
.rules .kind{font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:2em;line-height:1}
.rules .sub{margin-top:.7em;font-size:.56em;letter-spacing:.3em;text-transform:uppercase;color:rgba(16,35,28,.5)}
.parties{margin-top:1.5em;display:flex;gap:2em}
.parties>div{flex:1;min-width:0}
.items{margin-top:1.7em;text-align:left}
.item+.item{margin-top:1em}
.leader{display:flex;align-items:baseline;gap:.6em}
.leader .name{font-family:Georgia,"Times New Roman",serif;font-size:.92em;line-height:1.2}
.leader .fill{flex:1;border-bottom:1px dotted rgba(16,35,28,.38);transform:translateY(-.18em)}
.leader .amt{font-size:.74em;font-weight:600;white-space:nowrap}
.item .note{margin-top:.25em;font-size:.58em;color:rgba(16,35,28,.45)}
.due{margin-top:1.6em;border-top:1px solid rgba(16,35,28,.2);padding-top:1.1em}
.due .amt{margin-top:.2em;font-family:Georgia,"Times New Roman",serif;font-size:2em;line-height:1}
.due .sub{margin-top:.6em;font-size:.56em;color:rgba(16,35,28,.45)}
.pay{margin-top:auto;padding-top:1.4em;font-size:.6em;color:rgba(16,35,28,.5)}
.pay b{color:${INK};font-weight:600;word-break:break-all}
/* The pay line takes the slack, so the footer sits under it rather than the
   two of them each claiming half the empty page. */
.foot{margin-top:1.6em;text-align:center}
`;

  const items = d.lines
    .map(
      (l) => `<div class="item">
        <div class="leader">
          <span class="name">${esc(l.description)}</span>
          <span class="fill"></span>
          <span class="amt">${money(l.amountKobo)}</span>
        </div>
        ${l.qty > 1 ? `<div class="note">${l.qty} at ${money(l.unitAmountKobo)}</div>` : ""}
      </div>`,
    )
    .join("");

  const stamp = [d.number === null ? "" : `No. ${d.number}`, d.issueDate ? when(d.issueDate) : ""]
    .filter(Boolean)
    .join(" · ");

  const KIND: Record<DocumentData["variant"], string> = {
    invoice: "Invoice",
    quote: "Quote",
    receipt: "Receipt",
    sample: "Invoice",
  };

  const body = `<div class="wrap">
  <div class="mono">${esc(initials(d.businessName))}</div>
  <div class="biz">${esc(d.businessName)}</div>
  <div class="bizmeta">
    ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
    ${d.businessEmail ? `${esc(d.businessEmail)}` : ""}
  </div>

  <div class="rules"><div class="inner">
    <div class="kind">${KIND[d.variant]}</div>
    ${stamp ? `<div class="sub">${stamp}</div>` : ""}
  </div></div>

  <div class="parties">
    <div><div class="cap">Prepared for</div><div class="val">${esc(d.clientName)}</div></div>
    <div><div class="cap">${d.variant === "quote" ? "Valid until" : "Payable by"}</div><div class="val">${when(
      d.dueDate,
    )}</div></div>
  </div>

  <div class="items">${items}</div>

  <div class="due">
    <div class="cap">${d.variant === "receipt" ? "Amount paid" : "Amount due"}</div>
    <div class="amt">${money(d.variant === "receipt" ? d.amountPaidKobo : d.totalKobo)}</div>
    ${d.vatKobo > 0 ? `<div class="sub">Subtotal ${money(d.subtotalKobo)} · VAT ${money(d.vatKobo)}</div>` : ""}
  </div>

  <div class="pay">${
    d.publicUrl && d.variant !== "receipt" ? `Pay at <b>${esc(d.publicUrl)}</b>` : ""
  }</div>

  <div class="foot">${legal(d)}${madeWith(d)}</div>
</div>`;

  return page(css, body, d);
}

/**
 * Folio — a sand margin holding the facts, the work on clean paper beside it.
 *
 * Everything a client looks up twice — the number, the dates, who it is for —
 * sits in the margin in one place, so the page beside it can be only the work.
 */
function folio(d: DocumentData): string {
  const css = `
.row{flex:1;display:flex;min-height:0}
.margin{width:14.5em;flex:none;background:${SAND};display:flex;flex-direction:column;padding:2.4em 1.9em 1.9em}
.margin .biz{font-size:1em;font-weight:700;line-height:1.2}
.margin .bizmeta{margin-top:.6em;font-size:.58em;line-height:1.6;color:rgba(16,35,28,.55)}
.facts{margin-top:2.2em;display:flex;flex-direction:column;gap:1.2em}
.margin .pay{margin-top:auto;padding-top:1.6em}
.margin .url{margin-top:.35em;font-size:.6em;word-break:break-all}
.main{flex:1;min-width:0;display:flex;flex-direction:column;padding:2.4em 2.2em 1.9em}
.kind{font-size:2.2em;font-weight:800;letter-spacing:-.05em;line-height:1}
.sub{margin-top:.7em;font-size:.72em;color:rgba(16,35,28,.55)}
table{margin-top:2em}
thead th{text-align:left;padding-bottom:.65em;border-bottom:1.5px solid ${INK};
font-size:.58em;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(16,35,28,.5)}
thead th.r{text-align:right}
thead th.c{text-align:center}
tbody td{padding:.85em 0;border-bottom:1px solid rgba(16,35,28,.09);font-size:.84em}
.box{margin-top:1.3em;margin-left:auto;width:13em}
.trow{display:flex;justify-content:space-between;font-size:.74em;padding:.3em 0;color:rgba(16,35,28,.55)}
.bar{margin-top:1em;background:${INK};color:${CREAM};display:flex;align-items:center;
justify-content:space-between;gap:1.5em;padding:.9em 1.2em}
.bar .lbl{font-size:.6em;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.75}
.bar .amt{font-size:1.3em;font-weight:800;letter-spacing:-.03em;line-height:1}
.notes{margin-top:1.4em;font-size:.68em;line-height:1.6;color:rgba(16,35,28,.6);white-space:pre-wrap}
`;

  const fact = (k: string, v: string) => `<div><div class="cap">${k}</div><div class="val">${v}</div></div>`;
  const kindWord = TITLE[d.variant].charAt(0) + TITLE[d.variant].slice(1).toLowerCase();

  const body = `<div class="row">
  <div class="margin">
    <div class="biz">${esc(d.businessName)}</div>
    <div class="bizmeta">
      ${d.businessAddress ? `${esc(d.businessAddress)}<br>` : ""}
      ${d.businessEmail ? `${esc(d.businessEmail)}<br>` : ""}
      ${d.businessTin ? `TIN ${esc(d.businessTin)}` : ""}
    </div>

    <div class="facts">
      ${d.number === null ? "" : fact(`${d.variant === "quote" ? "Quote" : "Invoice"} no.`, String(d.number))}
      ${d.issueDate ? fact("Issued", when(d.issueDate)) : ""}
      ${d.dueDate ? fact(dueLabel(d), when(d.dueDate)) : ""}
      ${fact("Billed to", esc(d.clientName))}
    </div>

    ${
      d.publicUrl && d.variant !== "receipt"
        ? `<div class="pay"><div class="cap">Pay online</div><div class="url">${esc(d.publicUrl)}</div></div>`
        : ""
    }
  </div>

  <div class="main">
    <div class="kind">${kindWord}</div>
    ${
      // The client's name is already in the margin, so the strapline appears
      // only when it has the work to name instead.
      d.lines.length === 1 ? `<div class="sub">${esc(headline(d))}</div>` : ""
    }

    <table>
      <thead><tr><th>Description</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
      <tbody>${itemRows(d)}</tbody>
    </table>

    <div class="box">${smallSums(d)}</div>
    <div class="bar">
      <span class="lbl">${totalLabel(d)}</span>
      <span class="amt">${money(d.totalKobo)}</span>
    </div>

    ${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}

    <div class="foot">${legal(d)}${madeWith(d)}</div>
  </div>
</div>`;

  return page(css, body, d);
}

const RENDERERS: Partial<Record<TemplateId, (d: DocumentData) => string>> = {
  wordmark,
  statement,
  ledger,
  monolith,
  editorial,
  atelier,
  folio,
};

/**
 * Renders a document in a chosen layout, or returns null for the default.
 *
 * Null rather than throwing: a withdrawn or misspelled template should produce
 * the standard invoice, not no invoice.
 */
export function renderTemplate(id: string | null | undefined, d: DocumentData): string | null {
  const spec = templateById(id);
  // Classic is the original sheet, which lives in its own file because it is
  // also the fallback for everything else. Routed through here anyway, so no
  // caller has to know that one of the eight is special.
  if (spec.id === "classic") return renderDocumentHtml(d);
  const render = RENDERERS[spec.id];
  return render ? render(d) : null;
}

export { coin };
