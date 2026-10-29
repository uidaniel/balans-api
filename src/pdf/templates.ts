/**
 * The invoice layouts (PRD F24, and the design system PRD's template set).
 *
 * Twenty of them: two on Free, eighteen on Pro. The first eight exist as
 * React components in the web repo, where they are captured to WebP for the
 * landing page; the other twelve (templates-plus.ts) are captured from here,
 * since this is the renderer the documents come from. These
 * are the same designs rebuilt as plain HTML — the same paddings, rules and
 * type sizes, set in the same typefaces — because a user chooses a design from
 * the pictures on balans.ng and has to get the design in the pictures.
 *
 * Everything is sized in `em`, exactly as the originals are, so one font-size
 * on the sheet scales the whole document. That is what lets the same markup
 * serve an A4 page and a preview in the picker without a second copy to keep
 * in step. The shared pieces are in `kit.ts`; Classic is in `template.ts`,
 * because it is also the fallback.
 *
 * Where a marketing sheet shows something a document does not have — a
 * project name, a drawn signature, a studio tagline — the shape is kept and
 * the content comes from the document, or the space goes to what is there.
 * Nothing on somebody's invoice is invented.
 *
 * Colour never carries structure. The design system's seventh acceptance
 * criterion is that a document stays legible photocopied in black and white,
 * so the layouts lean on ink blocks, rules and weight instead.
 */

import { esc } from "../documents/page.ts";
import {
  biz,
  bizMeta,
  cap,
  CREAM,
  DISPLAY,
  due,
  dueLabel,
  field,
  headline,
  headlineAmount,
  fxNote,
  ink,
  INK,
  isReceipt,
  kind,
  legal,
  madeWith,
  MARIGOLD,
  methodWords,
  money,
  items,
  namesWork,
  numberLabel,
  owedKobo,
  party,
  onlineAt,
  onlineSection,
  payWhere,
  payInfo,
  notesBlock,
  titleBlock,
  hasVat,
  rows,
  sheet,
  shortUrl,
  signature,
  sums,
  totals,
  upperKind,
  when,
  type RenderOptions,
} from "./kit.ts";
import type { DocumentData } from "./template.ts";
import { renderDocumentHtml } from "./template.ts";
import { BRAND_SHEET, gold, PLUS_RENDERERS } from "./templates-plus.ts";

export type TemplateId =
  | "classic"
  | "wordmark"
  | "monolith"
  | "editorial"
  | "atelier"
  | "statement"
  | "ledger"
  | "folio"
  | keyof typeof PLUS_RENDERERS;

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
    name: "Glare",
    pro: false,
    blurb: "The amount on night green, under a soft fall of gold light. Clean white paper below.",
    ready: true,
  },
  // The first Pro design shown: the one that could only come from here.
  {
    id: "adire",
    name: "Adire",
    pro: true,
    blurb: "A band of adire cloth across the head and foot. The one that could only come from here.",
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
    name: "Fluted",
    pro: true,
    blurb: "A spine of reeded glass catching one band of light. Unmistakable across a desk.",
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
  // The second set (9 October 2026), in templates-plus.ts.
  {
    id: "swiss",
    name: "Swiss",
    pro: true,
    blurb: "A strict grid, one heavy rule and a lot of white. Hierarchy by size alone.",
    ready: true,
  },
  {
    id: "poster",
    name: "Poster",
    pro: true,
    blurb: "The amount set as large as the page allows, on a block of your colour.",
    ready: true,
  },
  {
    id: "ticket",
    name: "Ticket",
    pro: true,
    blurb: "The job on a ticket, the amount and date on a stub torn off at the perforation.",
    ready: true,
  },
  {
    id: "bento",
    name: "Bento",
    pro: true,
    blurb: "Every fact in its own rounded tile, the amount on the dark one. Like a product page.",
    ready: true,
  },
  {
    id: "gazette",
    name: "Gazette",
    pro: true,
    blurb: "Your name as a newspaper masthead, the work as the headline, the money in the sidebar.",
    ready: true,
  },
  {
    id: "slip",
    name: "Slip",
    pro: true,
    blurb: "A long torn slip down the page, set like a good till receipt. Everything centred.",
    ready: true,
  },
  {
    id: "letterhead",
    name: "Letterhead",
    pro: true,
    blurb: "Company stationery: a centred letterhead, a boxed table, a solid total. Procurement-ready.",
    ready: true,
  },
  {
    id: "meridian",
    name: "Meridian",
    pro: true,
    blurb: "A solid band of reference facts and striped rows. What a large client's accounts team expects.",
    ready: true,
  },
  {
    id: "blueprint",
    name: "Frost",
    pro: true,
    blurb: "Frosted white panels on warm sand, the amount on a panel of gold. Soft, and every fact boxed.",
    ready: true,
  },
  {
    id: "angle",
    name: "Halftone",
    pro: true,
    blurb: "Printed dots falling from the corner and the amount set large and light. Plain in the middle.",
    ready: true,
  },
  {
    id: "monogram",
    name: "Monogram",
    pro: true,
    blurb: "Your initials set enormous in the corner and the amount in an outlined pill.",
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
/* Glare (Free; the id is still "wordmark")                                   */
/* -------------------------------------------------------------------------- */

/**
 * Glare: the head of the page in night green, with a soft marigold light
 * falling into it from the top corner, printed as a fine halftone the way
 * the brand's posters are (29 October 2026; this id was Wordmark). The
 * amount sits on the band in large light type; everything under it is clean
 * white paper, so it still photocopies.
 *
 * A logo goes on a small white tile: most logos are drawn for white paper,
 * and an ink mark on night green would vanish.
 */
function wordmark(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const receipt = isReceipt(d) ? d.receipt : undefined;
  const css = `${BRAND_SHEET}
.band{position:relative;flex:none;overflow:hidden;background:#08130F;color:${CREAM};padding:1.6em 1.8em 1.35em}
.band .light{position:absolute;inset:0;pointer-events:none;
background:radial-gradient(70% 120% at 104% -12%,${gold(48)},${gold(18)} 38%,transparent 72%),
radial-gradient(34% 60% at 98% -6%,${gold(55, "#fff")},transparent 70%)}
.band .dots{position:absolute;inset:0;pointer-events:none;
background-image:radial-gradient(circle,rgba(255,244,214,.22) .05em,transparent .06em);background-size:.3em .3em;
-webkit-mask-image:radial-gradient(70% 120% at 104% -12%,#000,transparent 70%);mask-image:radial-gradient(70% 120% at 104% -12%,#000,transparent 70%)}
.band>*:not(.light):not(.dots){position:relative}
.band .top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.band .logo{min-width:0;flex-direction:column;align-items:flex-start;gap:.5em}
.band .logo img{height:2.2em;max-width:11em;background:#fff;border-radius:.4em;padding:.25em .4em}
.band .logo .biz{font-size:.78em}
.band .k{flex:none;font-size:.6em;color:rgba(246,241,231,.62)}
.band .k b{font-weight:600;color:${CREAM}}
.band .cap{color:rgba(246,241,231,.58)}
.band .due{margin-top:1.7em}
.band .due .amt{margin-top:.2em;color:${CREAM}}
.band .due.paid .amt{color:${CREAM}}
.band .fx{color:rgba(246,241,231,.62)}
.band .fx b{color:${CREAM}}
.band .facts{margin-top:1.3em;display:flex;gap:1.2em;border-top:1px solid rgba(246,241,231,.14);padding-top:.85em}
.band .facts>div{flex:1;min-width:0}
.band .facts>div:first-child{flex:1.7}
.band .fv .sub{color:rgba(246,241,231,.55)}
.band .dtitle .cap{color:rgba(246,241,231,.58)}
.body{flex:1;display:flex;flex-direction:column;padding:1.3em 1.8em 1.3em}
.body .sums{margin:.9em 0 0 auto;min-width:12em;width:max-content}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const facts = [
    field(isReceipt(d) ? "Received from" : "Billed to", party(d.clientName, d.clientEmail), "min0"),
    receipt
      ? field("Paid on", when(receipt.paidOn))
      : d.issueDate
        ? field("Issued", when(d.issueDate))
        : "",
    receipt
      ? field("Method", esc(methodWords(receipt.method)))
      : d.dueDate
        ? field(dueLabel(d), when(d.dueDate))
        : "",
    d.businessTin ? field("TIN", esc(d.businessTin)) : "",
  ].filter(Boolean);

  const body = `<div class="band">
  <div class="light"></div><div class="dots"></div>
  <div class="top">
    ${biz(d)}
    <p class="k"><b>${kind(d)}</b>${d.number === null ? "" : ` &middot; No. ${d.number}`}</p>
  </div>
  ${due(d, { size: `${Math.min(3, 26 / (Math.max(h.display.length, 5) * 0.6)).toFixed(2)}em` })}
  <div class="facts">${facts.join("")}</div>
</div>

<div class="body">
  ${titleBlock(d)}
  ${rows(d, { head: "rule" })}
  ${sums(d)}
  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    fonts: ["brand"],
    rowEm: 1.6,
    logoEm: 1,
    brand: (k) => `.band{background:${k.night}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Fluted (Pro; the id is still "monolith")                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fluted: a spine of reeded glass down the left edge, each rib catching one
 * band of marigold light a little lower than the last, like the ribbed glass
 * of the brand's posters (29 October 2026; this id was Monolith, and the
 * spine is what it keeps). The kind and number are set plainly in the main
 * column rather than turned up the spine in capitals.
 */
const RIBS = Array.from({ length: 12 }, (_, i) => {
  const t = i / 11;
  const c = 26 + 12 * Math.sin(t * Math.PI * 1.6 + 0.4) + 10 * t;
  const w = 8 + 4 * Math.cos(t * Math.PI * 2.2);
  const at = (v: number) => `${v.toFixed(1)}%`;
  return `<i style="background:linear-gradient(180deg,var(--night) 0%,var(--night) ${at(c - w)},${gold(45, "#fff")} ${at(c)},${MARIGOLD} ${at(c + w * 0.6)},color-mix(in srgb,var(--night) 70%,${MARIGOLD}) ${at(c + w * 2.2)},var(--night) ${at(c + w * 3.4)},var(--night) 100%)"></i>`;
}).join("");

function monolith(d: DocumentData, opts: RenderOptions): string {
  const css = `${BRAND_SHEET}
.row{flex:1;display:flex;min-height:0}
.spine{--night:#08130F;width:3.3em;flex:none;display:flex;background:var(--night)}
.spine i{flex:1;box-shadow:inset .04em 0 0 rgba(255,240,210,.08),inset -.04em 0 0 rgba(0,0,0,.35)}
.main{min-width:0;flex:1;display:flex;flex-direction:column;padding:1.7em 1.7em 1.4em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.kd h1{font-size:2.1em;line-height:1;font-weight:600;letter-spacing:-.045em}
.kd p{margin-top:.55em;font-size:.58em;line-height:1.6;color:${ink(0.55)}}
.brand{min-width:0;text-align:right}
.brand .logo{flex-direction:column;align-items:flex-end;gap:.45em}
.brand .logo img{height:2.6em;object-position:right center}
.brand .meta{margin-top:.4em}
.facts{margin-top:1.5em;display:flex;gap:1.4em;border-top:1px solid ${ink(0.12)};padding-top:1em}
.work{margin-top:1.3em}
.money{margin-top:1.3em;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em}
.money .sums{margin-top:0;min-width:12em;width:max-content}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
gap:1.2em;padding-top:1.4em}
.tail .left{min-width:0}
.tail .left>div+div{margin-top:1em}
.tail .terms{max-width:13em}
`;

  const dates = [
    d.issueDate ? `Issued ${when(d.issueDate)}` : "",
    d.dueDate && !isReceipt(d) ? `${dueLabel(d)} ${when(d.dueDate)}` : "",
    isReceipt(d) && d.receipt ? `Paid ${when(d.receipt.paidOn)}` : "",
  ].filter(Boolean);

  const body = `<div class="row">
  <div class="spine">${RIBS}</div>

  <div class="main">
    <div class="top">
      <div class="kd">
        <h1>${kind(d)}</h1>
        <p>${[d.number === null ? "" : `No. ${d.number}`, ...dates].filter(Boolean).join("<br>")}</p>
      </div>
      <div class="brand">
        ${biz(d)}
        <p class="meta">${bizMeta(d)}</p>
      </div>
    </div>

    ${titleBlock(d, "padding-top:1em")}
    <div class="facts">
      ${field(isReceipt(d) ? "Received from" : "Billed to", party(d.clientName, d.clientEmail), "min0")}
      ${
        // The number is under the heading already, so the second fact is
        // the work when one line names it, and nothing otherwise.
        namesWork(d) && !d.title ? field("Work", esc(headline(d))) : ""
      }
    </div>

    <div class="work">${rows(d, { head: "rule" })}</div>

    <div class="money">
      ${due(d)}
      ${sums(d)}
    </div>

    <div class="tail">
      <div class="left">
        ${payInfo(d)}
        ${notesBlock(d, "terms")}
      </div>
      ${signature(d)}
    </div>

    ${legal(d)}
    ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
  </div>
</div>`;

  return sheet(d, opts, { css, body, fonts: ["brand"], brand: (k) => `.spine{--night:${k.night}}.facts{border-top-color:${k.c}}` });
}

/* -------------------------------------------------------------------------- */
/* Editorial (Pro)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The work set as the headline, like the cover of a report.
 *
 * The largest thing on the page is what the invoice is for, not the word
 * "invoice", which is the one fact the client already knows.
 */
function editorial(d: DocumentData, opts: RenderOptions): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.8em 1.9em 1.4em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.brand{display:flex;align-items:center;gap:.55em;min-width:0}
.brand img{display:block;width:auto;max-width:12em;height:2.6em;object-fit:contain;flex:none}
.brand .biz{font-size:.72em;line-height:1.15;font-weight:700;letter-spacing:.08em;
text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand .meta{font-size:.48em;line-height:1.5;color:${ink(0.45)}}
.kindwrap{flex:none;text-align:right}
.kindwrap .k{font-size:.62em;font-weight:800;letter-spacing:.4em;text-transform:uppercase}
.kindwrap .no{margin-top:.3em;font-size:.54em;color:${ink(0.5)}}
.lede{margin-top:1.5em}
.lede h1{margin-top:.15em;font-family:${DISPLAY};font-size:2.3em;line-height:.9;
font-weight:800;letter-spacing:-.055em;overflow-wrap:anywhere}
.lede h1 span{color:${MARIGOLD}}
.strip{margin-top:1.2em;display:flex;gap:1em;border-top:1px solid ${ink(0.12)};
border-bottom:1px solid ${ink(0.12)};padding:.75em 0}
.strip>div{min-width:0;flex:1}
.strip>div.wide{flex:1.4}
.work{margin-top:1.1em}
.money{margin-top:1em;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em}
.money .sums{min-width:11.5em;width:max-content}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
gap:1.2em;padding-top:1em}
`;

  const body = `<div class="wrap">
  <div class="top">
    <div class="brand">
      ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
      <div class="min0">
        <p class="biz">${esc(d.businessName)}</p>
        <p class="meta">${bizMeta(d, ["email", "address"])}</p>
      </div>
    </div>
    <div class="kindwrap">
      <p class="k">${kind(d)}</p>
      ${d.number === null ? "" : `<p class="no">No. ${d.number}</p>`}
    </div>
  </div>

  <div class="lede">
    ${cap(d.title ? "Project" : namesWork(d) ? (d.variant === "quote" ? "Quoted for" : "Work") : "Billed to")}
    <h1>${esc(headline(d))}<span>.</span></h1>
  </div>

  <div class="strip">
    ${namesWork(d) ? field("Billed to", party(d.clientName, d.clientEmail), "wide") : ""}
    ${d.issueDate ? field("Issued", when(d.issueDate)) : ""}
    ${d.dueDate ? field(dueLabel(d), when(d.dueDate)) : ""}
    ${namesWork(d) ? "" : `<div class="wide"></div>`}
  </div>

  <div class="work">${rows(d, { rate: false })}</div>

  <div class="money">
    ${due(d, { size: "1.85em" })}
    ${sums(d)}
  </div>

  ${notesBlock(d, "nb")}

  <div class="tail">
    ${payInfo(d) || "<span></span>"}
    ${signature(d)}
  </div>

  ${legal(d)}
  ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
</div>`;

  return sheet(d, opts, { css, body, brand: (k) => `.kindwrap .k{color:${k.deep}}.strip{border-top-color:${k.c};border-bottom-color:${k.c}}.lede h1 span{color:${k.deep}}` });
}

/* -------------------------------------------------------------------------- */
/* Atelier (Pro)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Centred, serif, with a monogram and dotted leaders.
 *
 * Set like a menu rather than a spreadsheet. The monogram is drawn from the
 * business name, so it is theirs, and their own logo replaces it when they
 * have one: there is a single mark at the top of this sheet and it should be
 * the one they chose.
 */
function atelier(d: DocumentData, opts: RenderOptions): string {
  const css = `
.sheet{background:#FBF8F2}
.wrap{flex:1;display:flex;flex-direction:column;padding:1.9em 2.1em 1.5em;text-align:center}
.mono{margin:0 auto;width:2.2em;height:2.2em;border-radius:50%;
box-shadow:inset 0 0 0 .06em ${ink(0.5)};display:flex;align-items:center;justify-content:center;
font-family:"Instrument Serif",Georgia,serif;font-size:.9em;line-height:1}
.wrap>img{display:block;margin:0 auto;width:auto;max-width:14em;height:3.4em;object-fit:contain}
.biz{margin-top:.7em;font-size:.56em;font-weight:600;letter-spacing:.42em;text-transform:uppercase}
.addr{margin-top:.3em;font-size:.5em;line-height:1.5;color:${ink(0.45)}}
.rules{margin-top:1em;border-top:1px solid ${ink(0.2)};border-bottom:1px solid ${ink(0.2)};padding:.2em 0}
.rules .inner{border-top:1px solid ${ink(0.2)};border-bottom:1px solid ${ink(0.2)};padding:.6em 0}
.rules .k{font-family:"Instrument Serif",Georgia,serif;font-size:2em;line-height:1;font-style:italic}
.rules .sub{margin-top:.55em;font-size:.5em;letter-spacing:.3em;text-transform:uppercase;color:${ink(0.5)}}
.parties{margin-top:1em;display:flex;gap:1em}
.parties>div{flex:1;min-width:0}
.list{margin-top:1.1em;text-align:left}
.list>div+div{margin-top:.7em}
.leader{display:flex;align-items:baseline;gap:.5em}
.leader .nm{font-family:"Instrument Serif",Georgia,serif;font-size:.86em;line-height:1.1}
.leader .fill{flex:1;border-bottom:1px dotted ${ink(0.35)};margin-bottom:.2em}
.leader .amt{font-size:.6em;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.list .note{margin-top:.25em;font-size:.52em;color:${ink(0.45)}}
.owed{margin-top:1em;border-top:1px solid ${ink(0.2)};padding-top:.8em}
.owed .amt{margin-top:.15em;font-family:"Instrument Serif",Georgia,serif;font-size:1.9em;
line-height:1;font-variant-numeric:tabular-nums}
.owed .sub{margin-top:.45em;font-size:.5em;color:${ink(0.45)}}
.terms{margin-top:1em;font-size:.54em;line-height:1.55;color:${ink(0.55)};white-space:pre-wrap}
.sig{margin:auto auto 0;text-align:center}
.sig .space{justify-content:center}
.sig .who{border-top-color:${ink(0.35)}}
.where{margin-top:.8em;font-size:.48em;color:${ink(0.45)}}
.where b{font-weight:600;color:${INK}}
.legal{text-align:center}
.made{justify-content:center;margin-top:.5em}
`;

  const initials =
    d.businessName
      .split(/[\s&,.\-]+/)
      .filter((w) => /[A-Za-z]/.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "—";

  const list = d.lines
    .map(
      (l) => `<div>
      <div class="leader">
        <span class="nm">${esc(l.description)}</span>
        <span class="fill"></span>
        <span class="amt">${money(l.amountKobo)}</span>
      </div>
      <p class="note">${l.qty} at ${money(l.unitAmountKobo)}</p>
    </div>`,
    )
    .join("");

  const stamp = [d.number === null ? "" : `No. ${d.number}`, d.issueDate ? when(d.issueDate) : ""]
    .filter(Boolean)
    .join(" · ");

  const h = headlineAmount(d);

  const body = `<div class="wrap">
  ${
    d.logoDataUri
      ? `<img src="${d.logoDataUri}" alt="">`
      : `<div class="mono">${esc(initials)}</div>`
  }
  <p class="biz">${esc(d.businessName)}</p>
  <p class="addr">${bizMeta(d, ["address", "email"])}</p>

  <div class="rules"><div class="inner">
    <p class="k">${kind(d)}</p>
    ${stamp ? `<p class="sub">${stamp}</p>` : ""}
  </div></div>

  ${titleBlock(d, "padding-top:1em")}
  <div class="parties">
    ${field(isReceipt(d) ? "Received from" : "Prepared for", party(d.clientName, d.clientEmail))}
    ${
      isReceipt(d) && d.receipt
        ? field("Paid on", when(d.receipt.paidOn))
        : d.dueDate
          ? field(d.variant === "quote" ? "Valid until" : "Payable by", when(d.dueDate))
          : ""
    }
  </div>

  <div class="list">${list}</div>

  <div class="owed">
    ${cap(h.label)}
    <p class="amt">${h.display}</p>
    ${fxNote(d)}
    <p class="sub">Subtotal ${money(d.subtotalKobo)}${hasVat(d) ? ` · VAT (${d.vatPercent ?? 0}%) ${money(d.vatKobo)}` : ""}</p>
  </div>

  ${d.notes ? `<p class="terms">${esc(d.notes)}</p>` : ""}

  ${
    // The signature is what pushes the foot to the bottom of the page here;
    // without one, an empty spacer does the same job.
    signature(d, "auto") || `<div style="margin-top:auto"></div>`
  }

  ${
    payWhere(d)
      ? `<p class="where">${payWhere(d)}${d.variant === "quote" ? "" : d.bankDetails ? " · bank transfer" : " · card, transfer or USSD"}</p>`
      : ""
  }
  ${legal(d)}
  ${d.showMadeWith ? madeWith(d) : ""}
</div>`;

  // The serif leaders and the quantity under them make a row cost more here
  // than the numbered rows elsewhere; the sheet has to know before it fits.
  return sheet(d, opts, { css, body, fonts: ["sans", "display", "serif"], rowEm: 2.8, brand: (k) => `.mono{box-shadow:inset 0 0 0 .08em ${k.c};color:${k.deep}}.rules,.rules .inner{border-color:${k.c}}.rules .k,.owed .amt{color:${k.deep}}.biz{color:${k.deep}}` });
}

/* -------------------------------------------------------------------------- */
/* Statement (Pro)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The amount owed on an ink card at the top, like the front of a bill.
 *
 * Built for the one job an invoice has: nobody should have to hunt for what
 * they owe or where to pay it.
 */
function statement(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);

  const css = `
.card{flex:none;background:${INK};color:${CREAM};padding:1.6em 1.8em 1.3em}
.card .top{display:flex;align-items:center;justify-content:space-between;gap:1em}
.card .logo{min-width:0}
.card .logo img{height:2.5em;max-width:12em}
.card .logo .biz{font-size:.72em;font-weight:700}
.card .k{flex:none;font-size:.54em;letter-spacing:.3em;text-transform:uppercase;color:rgba(246,241,231,.55)}
.card .lbl{margin-top:2em;font-size:.56em;letter-spacing:.14em;text-transform:uppercase;color:rgba(246,241,231,.5)}
.card .amt{margin-top:.1em;font-family:${DISPLAY};font-size:3em;line-height:1;
font-weight:800;letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.card .when{margin-top:.8em;display:flex;flex-wrap:wrap;align-items:center;gap:.8em}
.card .when p{font-size:.6em;color:rgba(246,241,231,.7)}
.card .pill{border-radius:99em;background:${MARIGOLD};color:${INK};
padding:.35em .9em;font-size:.54em;font-weight:600}
.card .facts{margin-top:1.5em;display:flex;gap:1em;border-top:1px solid rgba(246,241,231,.15);
padding-top:.85em;font-size:.56em}
.card .facts>div{flex:1;min-width:0}
.card .facts .k2{font-size:.9em;letter-spacing:.12em;text-transform:uppercase;color:rgba(246,241,231,.45)}
.card .facts .v{margin-top:.3em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{flex:1;display:flex;flex-direction:column;padding:1.3em 1.8em 1.4em}
.body .sums{margin-top:1em;margin-left:auto;min-width:12em;width:max-content}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
gap:1.2em;padding-top:1.2em}
`;

  const fact = (k: string, v: string) =>
    `<div><p class="k2">${k}</p><p class="v">${v}</p></div>`;

  const receipt = isReceipt(d) ? d.receipt : undefined;
  const facts = [
    fact(isReceipt(d) ? "Received from" : "Billed to", esc(d.clientName)),
    receipt
      ? fact("Receipt no.", `#${receipt.number}`)
      : d.number === null
        ? ""
        : fact("Number", `#${d.number}`),
    receipt
      ? fact("Reference", esc(receipt.reference))
      : d.issueDate
        ? fact("Issued", when(d.issueDate))
        : "",
  ].filter(Boolean);

  const body = `<div class="card">
  <div class="top">
    ${biz(d)}
    <p class="k">${kind(d)}</p>
  </div>

  <p class="lbl">${h.label}</p>
  <p class="amt">${h.display}</p>
  ${fxNote(d)}
  <div class="when">
    ${
      isReceipt(d) && d.receipt
        ? `<p>Paid ${when(d.receipt.paidOn)} · ${esc(methodWords(d.receipt.method))}</p>`
        : d.dueDate
          ? `<p>${dueLabel(d)} ${when(d.dueDate)}</p>`
          : ""
    }
    ${
      d.publicUrl && !isReceipt(d) && owedKobo(d) > 0
        ? `<p class="pill">Pay at ${esc(shortUrl(d.publicUrl))}</p>`
        : ""
    }
  </div>

  ${titleBlock(d, "padding-top:1em")}
  <div class="facts">${facts.join("")}</div>
</div>

<div class="body">
  ${rows(d)}
  ${sums(d)}
  ${notesBlock(d, "nb")}
  <div class="tail">
    ${payInfo(d) || "<span></span>"}
    ${signature(d)}
  </div>
  ${legal(d)}
  ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
</div>`;

  return sheet(d, opts, { css, body, brand: (k) => `.card{background:${k.c};color:${k.on}}.card .k,.card .lbl,.card .when p,.card .facts .k2{color:${k.on};opacity:.72}.card .facts{border-top-color:${k.on === "#FFFFFF" ? "rgba(255,255,255,.22)" : "rgba(16,35,28,.18)"}}.card .pill{background:${k.on};color:${k.c}!important}` });
}

/* -------------------------------------------------------------------------- */
/* Ledger (Pro)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Numbered sections on a hard grid, the total bottom right.
 *
 * The accountant's one: every fact has a numbered place, so a query about an
 * invoice can name the section it is about.
 */
function ledger(d: DocumentData, opts: RenderOptions): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.7em 1.8em 1.4em}
.lg{display:block;width:auto;max-width:13em;height:2.8em;object-fit:contain;object-position:left center;margin-bottom:1em}
.mast{display:flex;align-items:flex-end;justify-content:space-between;gap:1em;padding-bottom:.8em}
.mast h1{font-family:${DISPLAY};font-size:2.1em;line-height:.85;font-weight:800;letter-spacing:-.05em}
.mast .right{flex:none;text-align:right;font-size:.56em;line-height:1.55}
.mast .no{display:flex;align-items:center;justify-content:flex-end;gap:.5em;font-weight:600}
.mast .no i{width:.6em;height:.6em;background:${MARIGOLD};display:block}
.mast .span{color:${ink(0.5)}}
.sec{display:flex;gap:1em;border-top:1px solid ${ink(0.15)};padding:.65em 0}
.sec .k{width:4.6em;flex:none;font-size:.54em;line-height:1.5}
.sec .k b{display:block;font-weight:400;font-variant-numeric:tabular-nums;color:${ink(0.35)}}
.sec .k span{font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.sec .v{min-width:0;flex:1}
.sec .line{font-size:.6em;line-height:1.55}
.sec .line.q{color:${ink(0.5)}}
.sec .line.b{font-weight:600}
.foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;
border-top:.14em solid ${INK};padding-top:.8em}
.foot .right{text-align:right}
.foot .sums{margin-bottom:.6em;margin-left:auto;min-width:11em;width:max-content;text-align:left}
`;

  const section = (n: number, k: string, inner: string) =>
    `<div class="sec">
      <p class="k"><b>${String(n).padStart(2, "0")}</b><span>${k}</span></p>
      <div class="v">${inner}</div>
    </div>`;

  const line = (text: string, cls = "") => `<p class="line ${cls}">${text}</p>`;

  const body = `<div class="wrap">
  ${d.logoDataUri ? `<img class="lg" src="${d.logoDataUri}" alt="">` : ""}
  <div class="mast">
    <h1>${kind(d)}</h1>
    <div class="right">
      ${d.number === null ? "" : `<p class="no"><i></i>No. ${d.number}</p>`}
      <p class="span">${
        d.issueDate && d.dueDate
          ? `${when(d.issueDate)} — ${when(d.dueDate)}`
          : d.issueDate
            ? when(d.issueDate)
            : ""
      }</p>
    </div>
  </div>

  ${titleBlock(d)}
  ${section(
    1,
    "From",
    line(esc(d.businessName), "b") + line(bizMeta(d).replace(/<br>/g, " · "), "q"),
  )}
  ${section(
    2,
    "To",
    line(esc(d.clientName), "b") + (d.clientEmail ? line(esc(d.clientEmail), "q") : ""),
  )}
  ${section(3, "Work", rows(d, { rate: false }))}
  ${payInfo(d) ? section(4, onlineSection(d), payInfo(d, { label: false })) : ""}
  ${d.notes ? section(5, "Terms", `<p class="note">${esc(d.notes)}</p>`) : ""}

  <div class="foot">
    ${signature(d)}
    <div class="right">
      ${sums(d)}
      ${due(d, { label: `${headlineAmount(d).label} (${headlineAmount(d).currency})` })}
    </div>
  </div>

  ${legal(d)}
  ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
</div>`;

  return sheet(d, opts, { css, body, brand: (k) => `.mast h1{color:${k.deep}}.sec .k span{color:${k.deep}}.foot{border-top-color:${k.c}}.mast{border-bottom:.14em solid ${k.c}}` });
}

/* -------------------------------------------------------------------------- */
/* Folio (Pro)                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A sand margin holding the facts, the work on clean paper beside it.
 *
 * Everything a client looks up twice — the number, the dates, who it is for —
 * sits in the margin in one place, so the page beside it can be only the work.
 */
function folio(d: DocumentData, opts: RenderOptions): string {
  const css = `
.row{flex:1;display:flex;min-height:0}
.margin{width:9em;flex:none;background:rgba(233,225,208,.7);display:flex;flex-direction:column;
padding:1.7em 1.2em 1.4em}
.margin img{display:block;width:auto;max-width:100%;height:3em;object-fit:contain;object-position:left center}
.margin .biz{margin-top:.8em;font-size:.74em;line-height:1.15;font-weight:700}
.margin .meta{margin-top:.4em;font-size:.5em;line-height:1.5;color:${ink(0.5)}}
.margin .facts{margin-top:1.6em}
.margin .facts>div+div{margin-top:.9em}
.main{min-width:0;flex:1;display:flex;flex-direction:column;padding:1.7em 1.5em 1.4em}
.main h1{font-family:${DISPLAY};font-size:2.2em;line-height:1;font-weight:800;letter-spacing:-.05em}
.main .sub{margin-top:.5em;font-size:.6em;color:${ink(0.55)};
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.work{margin-top:1.4em}
.main .sums{margin-top:1em;margin-left:auto;min-width:11em;width:max-content}
.bar{margin-top:.8em;display:flex;align-items:center;justify-content:space-between;gap:1em;
background:${INK};color:${CREAM};padding:.7em .9em}
.bar .k{font-size:.56em;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.bar .v{font-family:${DISPLAY};font-size:1.25em;line-height:1;font-weight:800;
letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
gap:1em;padding-top:1.2em}
.tail .terms{max-width:9em}
`;

  const h = headlineAmount(d);

  const facts = [
    d.number === null ? "" : field(numberLabel(d), String(d.number)),
    d.issueDate ? field("Issued", when(d.issueDate)) : "",
    isReceipt(d) && d.receipt
      ? field("Paid on", when(d.receipt.paidOn))
      : d.dueDate
        ? field(dueLabel(d), when(d.dueDate))
        : "",
    field(isReceipt(d) ? "Received from" : "Billed to", party(d.clientName, d.clientEmail)),
  ].filter(Boolean);

  const body = `<div class="row">
  <div class="margin">
    ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
    <p class="biz">${esc(d.businessName)}</p>
    <p class="meta">${bizMeta(d)}</p>
    <div class="facts">${facts.join("")}</div>
    ${payInfo(d, { className: "auto" })}
  </div>

  <div class="main">
    <h1>${kind(d)}</h1>
    ${d.title ? titleBlock(d, "margin-top:.8em") : namesWork(d) ? `<p class="sub">${esc(headline(d))}</p>` : ""}

    <div class="work">${rows(d, { rate: false })}</div>

    ${sums(d)}
    <div class="bar">
      <span class="k">${h.label}</span>
      <span class="v">${h.display}</span>
    </div>

    <div class="tail">
      ${notesBlock(d, "terms") || "<span></span>"}
      ${signature(d)}
    </div>

    ${legal(d)}
    ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
  </div>
</div>`;

  return sheet(d, opts, { css, body, brand: (k) => `.margin{background:${k.wash}}.main h1{color:${k.deep}}.bar{background:${k.c};color:${k.on}}` });
}

/* -------------------------------------------------------------------------- */

const RENDERERS: Partial<Record<TemplateId, (d: DocumentData, opts: RenderOptions) => string>> = {
  wordmark,
  statement,
  ledger,
  monolith,
  editorial,
  atelier,
  folio,
  ...PLUS_RENDERERS,
};

/**
 * Renders a document in a chosen layout, or returns null for the default.
 *
 * Null rather than throwing: a withdrawn or misspelled template should produce
 * the standard invoice, not no invoice.
 */
export function renderTemplate(
  id: string | null | undefined,
  d: DocumentData,
  opts: RenderOptions = {},
): string | null {
  const spec = templateById(id);
  // Classic is the original sheet, which lives in its own file because it is
  // also the fallback for everything else. Routed through here anyway, so no
  // caller has to know that one of the eight is special.
  if (spec.id === "classic") return renderDocumentHtml(d, opts);
  const render = RENDERERS[spec.id];
  return render ? render(d, opts) : null;
}
