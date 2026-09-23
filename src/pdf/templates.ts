/**
 * The invoice layouts (PRD F24, and the design system PRD's template set).
 *
 * Eight of them: two on Free, six on Pro. They exist as React components in
 * the web repo, where they are captured to WebP for the landing page. These
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
  payInfo,
  notesBlock,
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
/* Wordmark (Free)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The kind set large, the facts down a rail on the left.
 *
 * No colour blocks at all beyond the total: it is the layout that survives a
 * fax machine, which is still how some Nigerian offices receive an invoice.
 */
function wordmark(d: DocumentData, opts: RenderOptions): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.7em 1.8em 1.4em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.kind{font-size:1.9em;line-height:1;font-weight:800;letter-spacing:-.04em}
.brand{min-width:0;text-align:right}
.brand .logo{justify-content:flex-end}
.brand .meta{margin-top:.35em}
.body{margin-top:1.5em;display:flex;gap:1.4em}
.rail{width:6em;flex:none}
.rail>div+div{margin-top:.85em}
.work{min-width:0;flex:1;border-left:1px solid ${ink(0.12)};padding-left:1.3em}
.tail{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:1em;
border-top:1px solid ${ink(0.12)};padding-top:.9em;font-size:.58em;color:${ink(0.45)}}
.tail b{font-weight:600;color:${INK}}
.tail .made{font-size:1em}
`;

  const facts = [
    // No client email on the rail: it is six em wide, which a name fits and
    // an address does not.
    field("Billed to", party(d.clientName, null)),
    d.number === null ? "" : field(`${kind(d)} #`, String(d.number)),
    d.issueDate ? field("Issue date", when(d.issueDate)) : "",
    d.dueDate ? field(dueLabel(d), when(d.dueDate)) : "",
    d.businessTin ? field("TIN", esc(d.businessTin)) : "",
  ].filter(Boolean);

  const body = `<div class="wrap">
  <div class="top">
    <p class="kind">${upperKind(d)}</p>
    <div class="brand">
      ${biz(d)}
      <p class="meta">${bizMeta(d, ["address", "email"])}</p>
    </div>
  </div>

  <div class="body">
    <div class="rail">${facts.join("")}</div>
    <div class="work">
      ${items(d)}
      ${totals(d, { accent: "marigold" })}
      ${notesBlock(d, "nb")}
    </div>
  </div>

  <div class="tail">
    <span>${
      d.publicUrl && !isReceipt(d) && owedKobo(d) > 0
        ? `Pay online at <b>${esc(shortUrl(d.publicUrl))}</b>`
        : d.businessEmail
          ? esc(d.businessEmail)
          : ""
    }</span>
    ${d.showMadeWith ? madeWith(d) : d.businessEmail ? `<span>${esc(d.businessEmail)}</span>` : ""}
  </div>

  ${legal(d)}
</div>`;

  // The Free items table sets a taller row than the numbered Pro one.
  return sheet(d, opts, { css, body, rowEm: 1.6 });
}

/* -------------------------------------------------------------------------- */
/* Monolith (Pro)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A full-height ink spine with the word turned up it.
 *
 * The spine is the whole idea: one heavy block against a lot of white, so the
 * document is recognisable face down on a desk. Nothing is printed on it but
 * the word and the number, and nothing of ours — a Balans mark up the side of
 * somebody's invoice reads as their mark, which it is not.
 */
function monolith(d: DocumentData, opts: RenderOptions): string {
  const css = `
.row{flex:1;display:flex;min-height:0}
.spine{width:3.3em;flex:none;background:${INK};color:${CREAM};
display:flex;flex-direction:column;align-items:center;justify-content:space-between;
padding:1.7em 0 1.5em}
.spine .word{writing-mode:vertical-rl;transform:rotate(180deg);
font-family:${DISPLAY};font-size:1.75em;line-height:1;font-weight:800;letter-spacing:.2em}
.spine .no{writing-mode:vertical-rl;transform:rotate(180deg);font-size:.56em;
letter-spacing:.22em;opacity:.55}
.main{min-width:0;flex:1;display:flex;flex-direction:column;padding:1.7em 1.6em 1.4em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.dates{font-size:.56em;line-height:1.6;color:${ink(0.5)}}
.dates b{font-weight:600;color:${INK}}
.brand{min-width:0;text-align:right}
.brand .biz{font-size:.9em;line-height:1.1;font-weight:800;letter-spacing:.06em;
text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand img{display:block;margin-left:auto;margin-bottom:.4em;width:auto;max-width:8em;
height:1.6em;object-fit:contain}
.brand .meta{margin-top:.6em;font-size:.54em;line-height:1.5;color:${ink(0.5)}}
.facts{margin-top:1.6em;display:flex;gap:1.4em;border-top:1px solid ${ink(0.12)};padding-top:1em}
.work{margin-top:1.3em}
.sums{margin-top:1.3em}
.money{margin-top:1.3em;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em}
.money .sums{margin-top:0;width:12em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
gap:1.2em;padding-top:1.4em}
.tail .left{min-width:0}
.tail .left>div+div{margin-top:1em}
.tail .terms{max-width:13em}
`;

  const body = `<div class="row">
  <div class="spine">
    <p class="word">${upperKind(d)}</p>
    ${d.number === null ? "<span></span>" : `<p class="no">No. ${d.number}</p>`}
  </div>

  <div class="main">
    <div class="top">
      <div class="dates">
        ${d.number === null ? "" : `<b>No. ${d.number}</b><br>`}
        ${d.issueDate ? `Issued ${when(d.issueDate)}<br>` : ""}
        ${d.dueDate ? `${dueLabel(d)} ${when(d.dueDate)}` : ""}
      </div>
      <div class="brand">
        ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
        <p class="biz">${esc(d.businessName)}</p>
        <p class="meta">${bizMeta(d)}</p>
      </div>
    </div>

    <div class="facts">
      ${field(isReceipt(d) ? "Received from" : "Billed to", party(d.clientName, d.clientEmail), "min0")}
      ${
        namesWork(d)
          ? field("Work", esc(headline(d)))
          : d.number === null
            ? ""
            : field(numberLabel(d), String(d.number))
      }
    </div>

    <div class="work">${rows(d, { head: "bar" })}</div>

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

  return sheet(d, opts, { css, body });
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
.brand img{display:block;width:auto;max-width:7em;height:1.5em;object-fit:contain;flex:none}
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
.money .sums{width:11.5em}
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
    ${cap(namesWork(d) ? (d.variant === "quote" ? "Quoted for" : "Work") : "Billed to")}
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

  return sheet(d, opts, { css, body });
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
.wrap>img{display:block;margin:0 auto;width:auto;max-width:9em;height:2.2em;object-fit:contain}
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
      ${l.qty > 1 ? `<p class="note">${l.qty} at ${money(l.unitAmountKobo)}</p>` : ""}
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
    <p class="amt">${money(h.amount)}</p>
    <p class="sub">Subtotal ${money(d.subtotalKobo)} · VAT (${d.vatPercent ?? 0}%) ${money(d.vatKobo)}</p>
  </div>

  ${d.notes ? `<p class="terms">${esc(d.notes)}</p>` : ""}

  ${signature(d, "auto")}

  ${
    d.publicUrl && !isReceipt(d) && owedKobo(d) > 0
      ? `<p class="where">Pay online at <b>${esc(shortUrl(d.publicUrl))}</b> · card, transfer or USSD</p>`
      : ""
  }
  ${legal(d)}
  ${d.showMadeWith ? madeWith(d) : ""}
</div>`;

  // The serif leaders and the quantity under them make a row cost more here
  // than the numbered rows elsewhere; the sheet has to know before it fits.
  return sheet(d, opts, { css, body, fonts: ["sans", "display", "serif"], rowEm: 2.8 });
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
.card .logo img{height:1.5em;max-width:7em}
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
.body .sums{margin-top:1em;margin-left:auto;width:12em}
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
  <p class="amt">${money(h.amount)}</p>
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

  return sheet(d, opts, { css, body });
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
.foot .sums{margin-bottom:.6em;margin-left:auto;width:11em;text-align:left}
`;

  const section = (n: number, k: string, inner: string) =>
    `<div class="sec">
      <p class="k"><b>${String(n).padStart(2, "0")}</b><span>${k}</span></p>
      <div class="v">${inner}</div>
    </div>`;

  const line = (text: string, cls = "") => `<p class="line ${cls}">${text}</p>`;

  const body = `<div class="wrap">
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
  ${payInfo(d) ? section(4, "Pay", payInfo(d, { label: false })) : ""}
  ${d.notes ? section(5, "Terms", `<p class="note">${esc(d.notes)}</p>`) : ""}

  <div class="foot">
    ${signature(d)}
    <div class="right">
      ${sums(d)}
      ${due(d, { label: `${headlineAmount(d).label} (NGN)` })}
    </div>
  </div>

  ${legal(d)}
  ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
</div>`;

  return sheet(d, opts, { css, body });
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
.margin img{display:block;width:auto;max-width:6.4em;height:1.7em;object-fit:contain}
.margin .biz{margin-top:.8em;font-size:.74em;line-height:1.15;font-weight:700}
.margin .meta{margin-top:.4em;font-size:.5em;line-height:1.5;color:${ink(0.5)}}
.margin .facts{margin-top:1.6em}
.margin .facts>div+div{margin-top:.9em}
.main{min-width:0;flex:1;display:flex;flex-direction:column;padding:1.7em 1.5em 1.4em}
.main h1{font-family:${DISPLAY};font-size:2.2em;line-height:1;font-weight:800;letter-spacing:-.05em}
.main .sub{margin-top:.5em;font-size:.6em;color:${ink(0.55)};
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.work{margin-top:1.4em}
.main .sums{margin-top:1em;margin-left:auto;width:11em}
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
    ${namesWork(d) ? `<p class="sub">${esc(headline(d))}</p>` : ""}

    <div class="work">${rows(d, { rate: false })}</div>

    ${sums(d)}
    <div class="bar">
      <span class="k">${h.label}</span>
      <span class="v">${money(h.amount)}</span>
    </div>

    <div class="tail">
      ${notesBlock(d, "terms") || "<span></span>"}
      ${signature(d)}
    </div>

    ${legal(d)}
    ${d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : ""}
  </div>
</div>`;

  return sheet(d, opts, { css, body });
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
