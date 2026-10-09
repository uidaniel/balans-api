/**
 * Twelve more Pro layouts (9 October 2026), on top of the original eight.
 *
 * Drawn from the shapes premium invoice kits keep coming back to — the Swiss
 * grid, the newspaper masthead, the architect's title block, the ticket stub,
 * the corporate band — and rebuilt here from the same kit as the rest, so
 * every promise the eight make holds for these too: the client's name and the
 * total are on the face, section 12's lines are on it, nothing is fetched,
 * nothing is invented, and colour never carries structure on its own.
 *
 * Marigold is swapped for a Pro brand colour by `applyBrand` wherever it
 * appears, so a layout only names its ink surfaces in `brand`: the places
 * where a swap of the accent alone would leave the colour on a hairline.
 *
 * Text that sits on a filled surface is coloured `inherit` and dimmed with
 * opacity rather than given a cream rgba, because a brand colour can be pale
 * enough to need ink on it, and a fixed cream would vanish there.
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
  fxNote,
  headline,
  headlineAmount,
  ink,
  INK,
  isReceipt,
  kind,
  legal,
  madeWith,
  MARIGOLD,
  MARIGOLD_DEEP,
  methodWords,
  money,
  namesWork,
  notesBlock,
  numberLabel,
  party,
  payInfo,
  qty,
  rows,
  sheet,
  signature,
  sums,
  titleBlock,
  upperKind,
  when,
  type RenderOptions,
} from "./kit.ts";
import { FONT } from "./fonts.ts";
import type { DocumentData } from "./template.ts";

const SERIF = FONT.serif;

/* -------------------------------------------------------------------------- */
/* Small helpers these layouts share                                          */
/* -------------------------------------------------------------------------- */

/** "No. 14", or nothing on a document without a number. */
const no = (d: DocumentData): string => (d.number === null ? "" : `No. ${esc(String(d.number))}`);

/** Who it is to, under the right word for what kind of document it is. */
const billedTo = (d: DocumentData, line: string | null = d.clientEmail): string =>
  field(isReceipt(d) ? "Received from" : "Billed to", party(d.clientName, line));

/** The date the client is looking for: when it was paid, or when it is due. */
function dueField(d: DocumentData): string {
  if (isReceipt(d) && d.receipt) return field("Paid on", when(d.receipt.paidOn));
  return d.dueDate ? field(dueLabel(d), when(d.dueDate)) : "";
}

/** Address, email and TIN on one line, for the layouts that run them across. */
const metaLine = (d: DocumentData): string => bizMeta(d).replace(/<br>/g, " &middot; ");

/** Up to two initials from the business name: "Ada Studio" is "AS". */
const initials = (name: string): string =>
  name
    .split(/[\s&,.\-]+/)
    .filter((w) => /[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "—";

/**
 * A size, in em, that keeps a figure on one line in the width it is given.
 *
 * The large amounts are what these layouts are built around, and "₦12,500,000.00"
 * is fourteen characters where "₦85,000.00" is ten. Set at one size, the long
 * one runs off the edge. Display figures run at about 0.6em a character.
 */
const fit = (text: string, max: number, width: number): string =>
  Math.min(max, width / (Math.max(text.length, 5) * 0.6)).toFixed(2);

/** The Balans line, in its own row, on the layouts that have nowhere else for it. */
const made = (d: DocumentData): string =>
  d.showMadeWith ? `<div style="margin-top:.5em">${madeWith(d)}</div>` : "";

/* -------------------------------------------------------------------------- */
/* Swiss                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A strict grid, flush left, hierarchy by size alone.
 *
 * One heavy rule, one square of colour, and a lot of white. The word is the
 * largest thing on the page; everything else is set small and placed exactly.
 */
function swiss(d: DocumentData, opts: RenderOptions): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.9em 2em 1.4em}
.top{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.4em;align-items:start}
.top .logo{flex-direction:column;align-items:flex-start;gap:.5em;min-width:0}
.top .meta{overflow-wrap:anywhere}
.word{margin-top:2.8em;display:flex;align-items:flex-end;justify-content:space-between;gap:1em}
.word h1{font-family:${DISPLAY};font-size:3.6em;line-height:.78;font-weight:800;letter-spacing:-.065em}
.word h1 i{display:inline-block;width:.19em;height:.19em;margin-left:.08em;background:${MARIGOLD}}
.word .no{font-family:${DISPLAY};font-size:1.05em;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.grid{margin-top:1.1em;display:grid;grid-template-columns:2fr 1fr 1fr;gap:1.4em;
border-top:.16em solid ${INK};padding-top:.8em}
.work{margin-top:1.8em}
.money{margin-top:1.4em;display:grid;grid-template-columns:1fr 1fr;gap:1.4em;align-items:end;
border-top:1px solid ${ink(0.15)};padding-top:1em}
.money .sums{width:12em}
.money .due{text-align:right}
.money .fx{margin-left:auto}
.tail{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:1.4em;align-items:end;padding-top:1.4em}
.tail .r{display:flex;justify-content:flex-end}
`;

  const body = `<div class="wrap">
  <div class="top">
    ${biz(d)}
    <p class="meta">${bizMeta(d)}</p>
  </div>

  <div class="word">
    <h1>${kind(d)}<i></i></h1>
    <p class="no">${no(d)}</p>
  </div>

  <div class="grid">
    ${billedTo(d)}
    ${d.issueDate ? field("Issued", when(d.issueDate)) : "<div></div>"}
    ${dueField(d) || "<div></div>"}
  </div>

  <div class="work">${titleBlock(d)}${rows(d)}</div>

  <div class="money">
    ${sums(d)}
    ${due(d)}
  </div>
  ${notesBlock(d, "nb")}

  <div class="tail">
    <div>${payInfo(d)}</div>
    <div class="r">${signature(d)}</div>
  </div>

  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.6,
    logoEm: 1.6,
    brand: (k) => `.grid{border-top-color:${k.c}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Gazette                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A newspaper front page: the business as the masthead, a dateline between
 * double rules, the work as the headline and the money in a sidebar.
 */
function gazette(d: DocumentData, opts: RenderOptions): string {
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.7em 1.9em 1.4em}
.mast{text-align:center;padding-bottom:.6em;border-bottom:1px solid ${INK}}
.mast img{display:block;margin:0 auto .55em;width:auto;height:2.6em;max-width:12em;object-fit:contain}
.mast h1{font-family:${SERIF};font-size:2.75em;line-height:1;font-weight:400;letter-spacing:-.01em;overflow-wrap:anywhere}
.mast .meta{margin-top:.45em}
.dateline{display:flex;justify-content:space-between;gap:1em;border-bottom:.24em double ${INK};
padding:.5em 0;font-size:.54em;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
.dateline span{flex:1}
.dateline .k{text-align:center;color:${MARIGOLD_DEEP}}
.dateline span:last-child{text-align:right}
.lede{margin-top:1.2em}
.lede h2{font-family:${SERIF};font-size:2.1em;line-height:1.02;font-weight:400;letter-spacing:-.01em;overflow-wrap:anywhere}
.lede .deck{margin-top:.4em;font-family:${SERIF};font-style:italic;font-size:.92em;color:${ink(0.6)}}
.cols{margin-top:1.1em;display:flex;gap:1.3em;border-top:1px solid ${INK};padding-top:1em}
.main{flex:1;min-width:0}
.main .sums{margin-top:1em;margin-left:auto;width:11em}
.side{width:8.8em;flex:none;border-left:1px solid ${ink(0.2)};padding-left:1.2em}
.side>div+div{margin-top:1.1em}
.side .due .amt{font-family:${SERIF};font-weight:400;letter-spacing:-.01em}
.foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.foot .left>div+div{margin-top:1em}
.foot .terms{max-width:18em}
`;

  const h = headlineAmount(d);
  const count = d.lines.length;
  const deck = namesWork(d)
    ? `${isReceipt(d) ? "Received from" : "For"} ${esc(d.clientName)}`
    : `${count} item${count === 1 ? "" : "s"}${d.dueDate && !isReceipt(d) ? ` &middot; ${dueLabel(d).toLowerCase()} ${when(d.dueDate)}` : ""}`;

  const body = `<div class="wrap">
  <div class="mast">
    ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
    <h1>${esc(d.businessName)}</h1>
    ${bizMeta(d) ? `<p class="meta">${metaLine(d)}</p>` : ""}
  </div>
  <div class="dateline">
    <span>${no(d)}</span>
    <span class="k">${upperKind(d)}</span>
    <span>${d.issueDate ? when(d.issueDate) : ""}</span>
  </div>

  <div class="lede">
    ${cap(d.title ? "Project" : namesWork(d) ? (d.variant === "quote" ? "Quoted for" : "The work") : isReceipt(d) ? "Received from" : "Billed to")}
    <h2>${esc(headline(d))}</h2>
    <p class="deck">${deck}</p>
  </div>

  <div class="cols">
    <div class="main">
      ${rows(d, { rate: false })}
      ${sums(d)}
    </div>
    <div class="side">
      ${due(d, { size: `${fit(h.display, 1.9, 8.2)}em` })}
      ${namesWork(d) ? billedTo(d) : ""}
      ${dueField(d)}
    </div>
  </div>

  <div class="foot">
    <div class="left">${payInfo(d)}${notesBlock(d, "terms")}</div>
    ${signature(d)}
  </div>

  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 1.8,
    fonts: ["sans", "display", "serif"],
    brand: (k) => `.mast,.cols{border-color:${k.c}}.dateline{border-bottom-color:${k.c}}.dateline .k{color:${k.deep}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Blueprint                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An architect's drawing sheet: a faint grid, a ruled frame, and the facts in
 * a title block in the bottom right corner, where anyone who has read a
 * drawing looks for them.
 */
function blueprint(d: DocumentData, opts: RenderOptions): string {
  const css = `
.sheet{background-color:#fff;
background-image:linear-gradient(${ink(0.04)} 1px,transparent 1px),linear-gradient(90deg,${ink(0.04)} 1px,transparent 1px),
linear-gradient(${ink(0.075)} 1px,transparent 1px),linear-gradient(90deg,${ink(0.075)} 1px,transparent 1px);
background-size:1em 1em,1em 1em,5em 5em,5em 5em}
.frm{position:absolute;inset:1.1em;border:.1em solid ${INK};pointer-events:none}
.wrap{position:relative;flex:1;display:flex;flex-direction:column;padding:2em 2.1em 1.9em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1.2em}
.kd .k{font-family:${DISPLAY};font-size:1.7em;line-height:1;font-weight:800;letter-spacing:.24em}
.kd .n{margin-top:.5em;font-size:.56em;letter-spacing:.2em;text-transform:uppercase;color:${ink(0.55)}}
.top .brand{text-align:right;min-width:0}
.top .brand .logo{flex-direction:column;align-items:flex-end;gap:.4em}
.top .brand .logo img{height:2.3em;object-position:right center}
.top .brand .meta{margin-top:.35em}
.panel{margin-top:1.3em;background:#fff;border:1px solid ${INK};padding:.9em 1em .4em}
.panel .rows .it:last-child{border-bottom:0}
.notes{margin-top:1em;background:#fff;display:inline-block;padding:.2em .3em 0 0}
.foot{margin-top:auto;display:flex;gap:1.4em;align-items:flex-end;padding-top:1em}
.foot .left{flex:1;min-width:0;display:flex;flex-direction:column;gap:1em}
.foot .left>*{background:#fff;align-self:flex-start;padding:.2em .3em 0 0}
.tb{width:13.6em;flex:none;background:#fff;border:.1em solid ${INK};display:grid;grid-template-columns:1fr 1fr}
.tb>div{min-width:0;padding:.5em .65em;border-right:1px solid ${INK};border-bottom:1px solid ${INK}}
.tb>div:nth-child(even){border-right:0}
.tb .wide{grid-column:1 / -1;border-right:0}
.tb>div:last-child{border-bottom:0}
.tb .fv .sub{font-size:.9em}
.made{margin-top:.6em}
`;

  const h = headlineAmount(d);
  const halves = [
    d.number === null ? "" : field(numberLabel(d), esc(String(d.number))),
    d.issueDate ? field("Issued", when(d.issueDate)) : "",
    dueField(d),
    isReceipt(d) && d.receipt ? field("Method", esc(methodWords(d.receipt.method))) : "",
  ].filter(Boolean);
  // The title block is a grid of pairs: an odd one out gets an empty partner
  // so the rules still meet.
  if (halves.length % 2) halves.push("<div></div>");

  const cells = [
    `<div class="wide">${billedTo(d)}</div>`,
    ...halves,
    `<div class="wide">${due(d, { size: `${fit(h.display, 1.5, 12.2)}em` })}</div>`,
  ].join("");

  const body = `<div class="frm"></div>
<div class="wrap">
  <div class="top">
    <div class="kd">
      <p class="k">${upperKind(d)}</p>
      <p class="n">${[no(d), d.issueDate ? when(d.issueDate) : ""].filter(Boolean).join(" &middot; ")}</p>
    </div>
    <div class="brand">
      ${biz(d)}
      <p class="meta">${bizMeta(d)}</p>
    </div>
  </div>

  <div class="panel">${titleBlock(d)}${rows(d)}</div>
  <div style="display:flex;justify-content:flex-end"><div class="panel" style="margin-top:-1px;border-top:0;padding:.7em 1em;width:13em">${sums(d)}</div></div>
  ${notesBlock(d, "notes")}

  <div class="foot">
    <div class="left">
      ${payInfo(d) || ""}
      ${signature(d)}
    </div>
    <div class="tb">${cells}</div>
  </div>

  ${legal(d)}
  ${d.showMadeWith ? madeWith(d) : ""}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.9,
    logoEm: 2.2,
    brand: (k) => `.frm,.panel,.tb,.tb>div{border-color:${k.c}}.kd .k{color:${k.deep}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Poster                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The amount as a poster: a block of colour across the top with the figure
 * set as large as the width allows. Nobody misreads what is owed.
 */
function poster(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const css = `
.block{flex:none;background:${MARIGOLD};color:${INK};padding:1.6em 1.9em 1.4em;display:flex;flex-direction:column;min-height:13.6em}
.block .top{display:flex;justify-content:space-between;align-items:flex-start;gap:1em}
.block .k{flex:none;font-size:.6em;font-weight:700;letter-spacing:.3em;text-transform:uppercase}
.block .k span{display:block;margin-top:.5em;text-align:right;letter-spacing:.12em;opacity:.7}
.block .lbl{margin-top:auto;font-size:.62em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.7}
.block .amt{margin-top:.08em;font-family:${DISPLAY};font-size:${fit(h.display, 4.4, 24.5)}em;line-height:.92;font-weight:800;
letter-spacing:-.06em;font-variant-numeric:tabular-nums;white-space:nowrap}
.block .when{margin-top:.75em;font-size:.66em;font-weight:600}
.block .fx,.block .fx b{color:inherit}
.block .fx{opacity:.75}
.body{flex:1;display:flex;flex-direction:column;padding:1.3em 1.9em 1.3em}
.facts{display:flex;gap:1.4em}
.facts>div{flex:1;min-width:0}
.work{margin-top:1.2em}
.body .sums{margin-top:1em;margin-left:auto;width:12em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const whenLine =
    isReceipt(d) && d.receipt
      ? `Paid ${when(d.receipt.paidOn)} &middot; ${esc(methodWords(d.receipt.method))}`
      : d.dueDate && !h.paid
        ? `${dueLabel(d)} ${when(d.dueDate)}`
        : "";

  const body = `<div class="block">
  <div class="top">
    ${biz(d)}
    <p class="k">${kind(d)}${d.number === null ? "" : `<span>${no(d)}</span>`}</p>
  </div>
  <p class="lbl">${h.label}</p>
  <p class="amt">${h.display}</p>
  ${fxNote(d)}
  ${whenLine ? `<p class="when">${whenLine}</p>` : ""}
</div>

<div class="body">
  ${titleBlock(d)}
  <div class="facts">
    ${billedTo(d)}
    ${d.issueDate ? field("Issued", when(d.issueDate)) : ""}
    ${bizMeta(d) ? field("From", bizMeta(d, ["email", "address"]) || esc(d.businessName)) : ""}
  </div>
  <div class="work">${rows(d)}</div>
  ${sums(d)}
  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, { css, body, rowEm: 3.3, brand: (k) => `.block{color:${k.on}}` });
}

/* -------------------------------------------------------------------------- */
/* Ticket                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The top of the page is a ticket: the job on the left, and on a stub torn
 * off at a perforation, the amount and the date. The work is listed under it.
 */
function ticket(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.7em 1.7em 1.4em}
.tk{position:relative;display:flex;min-height:12.5em;border-radius:1em;overflow:hidden}
.tk .main{flex:1;min-width:0;background:${CREAM};padding:1.35em 1.5em;display:flex;flex-direction:column}
.tk .main .logo{min-width:0;flex-direction:column;align-items:flex-start;gap:.45em}
.tk .main .logo img{height:2.4em}
.tk .main .k{margin-top:auto;padding-top:1.6em;font-size:.56em;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:${ink(0.55)}}
.tk .main h1{margin-top:.25em;font-family:${DISPLAY};font-size:1.75em;line-height:1.02;font-weight:800;
letter-spacing:-.045em;overflow-wrap:anywhere}
.tk .main .facts{margin-top:.9em;display:flex;gap:1.3em}
.tk .main .facts>div{min-width:0}
.tk .stub{position:relative;width:10.6em;flex:none;background:${INK};color:${CREAM};padding:1.35em 1.25em;
display:flex;flex-direction:column}
.tk .stub::before{content:"";position:absolute;left:-.06em;top:1em;bottom:1em;border-left:.13em dashed ${CREAM}}
.tk .notch{position:absolute;right:10.6em;width:1.3em;height:1.3em;margin-right:-.65em;border-radius:50%;background:#fff}
.tk .notch.t{top:-.65em}
.tk .notch.b{bottom:-.65em}
.stub .lbl{font-size:.56em;font-weight:700;letter-spacing:.18em;text-transform:uppercase;opacity:.6}
.stub .amt{margin-top:.25em;font-family:${DISPLAY};font-size:${fit(h.display, 1.6, 8.1)}em;line-height:1;font-weight:800;
letter-spacing:-.04em;font-variant-numeric:tabular-nums;white-space:nowrap}
.stub .fx,.stub .fx b{color:inherit}
.stub .fx{opacity:.7;font-size:.48em}
.stub .row2{margin-top:auto;padding-top:1em;display:flex;justify-content:space-between;gap:.6em}
.stub .row2 .cap,.stub .row2 .fv{color:inherit}
.stub .row2 .cap{opacity:.6}
.work{margin-top:1.6em}
.wrap .sums{margin-top:1em;margin-left:auto;width:12em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const dateFact =
    isReceipt(d) && d.receipt
      ? field("Paid on", when(d.receipt.paidOn))
      : d.dueDate
        ? field(dueLabel(d), when(d.dueDate))
        : d.issueDate
          ? field("Issued", when(d.issueDate))
          : "";

  const body = `<div class="wrap">
  <div class="tk">
    <div class="main">
      ${biz(d)}
      <p class="k">${kind(d)}${d.number === null ? "" : ` &middot; ${no(d)}`}</p>
      <h1>${esc(headline(d))}</h1>
      <div class="facts">
        ${namesWork(d) ? billedTo(d, null) : ""}
        ${d.issueDate ? field("Issued", when(d.issueDate)) : ""}
        ${bizMeta(d, ["email"]) ? field("Contact", bizMeta(d, ["email"])) : ""}
      </div>
    </div>
    <div class="stub">
      <p class="lbl">${h.label}</p>
      <p class="amt">${h.display}</p>
      ${fxNote(d)}
      <div class="row2">
        ${dateFact}
      </div>
    </div>
    <span class="notch t"></span><span class="notch b"></span>
  </div>

  <div class="work">${titleBlock(d)}${rows(d)}</div>
  ${sums(d)}

  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.4,
    brand: (k) => `.tk .stub{background:${k.c};color:${k.on}}.tk .stub::before{border-left-color:${k.on}}.tk .main{background:${k.wash}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Letterhead                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Company stationery: the business centred at the head of the page over a
 * double rule, a boxed table, and a totals box that ends in a solid row. The
 * one a procurement office files without a second look.
 */
function letterhead(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const owed = d.totalKobo - d.amountPaidKobo;
  const part = !isReceipt(d) && d.amountPaidKobo > 0 && owed > 0;

  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.8em 2em 1.4em}
.lh{text-align:center}
.lh img{display:block;margin:0 auto;width:auto;height:3em;max-width:14em;object-fit:contain}
.lh .biz{margin-top:.35em;font-family:${DISPLAY};font-size:1.4em;line-height:1.1;font-weight:800;letter-spacing:-.03em;overflow-wrap:anywhere}
.lh .meta{margin-top:.35em}
.r1{margin-top:1em;height:.24em;background:${MARIGOLD}}
.r2{margin-top:.16em;height:1px;background:${INK}}
.head{margin-top:1.5em;display:flex;justify-content:space-between;gap:1.4em;align-items:flex-start}
.head h1{font-size:1.15em;font-weight:700;letter-spacing:.26em;text-transform:uppercase}
.head .to{margin-top:1em}
.kv{font-size:.6em;border-collapse:collapse}
.kv td{padding:.2em 0;white-space:nowrap}
.kv td:first-child{color:${ink(0.5)};padding-right:1.4em;text-align:right}
.kv td:last-child{font-weight:600;text-align:right}
.tbl{margin-top:1.5em;width:100%;border-collapse:collapse;font-size:.6em}
.tbl th{background:${CREAM};text-align:left;font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:.85em;
padding:.75em .85em;border:1px solid ${ink(0.15)}}
.tbl td{padding:.7em .85em;border:1px solid ${ink(0.12)};vertical-align:top}
.tbl .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.tbl td.nm{font-weight:600}
.tot{margin-left:auto;margin-top:-1px;width:18em;border-collapse:collapse;font-size:.6em}
.tot td{padding:.6em .85em;border:1px solid ${ink(0.12)};font-variant-numeric:tabular-nums}
.tot td:first-child{color:${ink(0.55)}}
.tot td:last-child{text-align:right;white-space:nowrap}
.tot tr.g td{background:${INK};color:${CREAM};font-weight:700;border-color:${INK}}
.tot tr.g td:last-child{font-family:${DISPLAY};font-size:1.3em;letter-spacing:-.02em}
.fxw{display:flex;justify-content:flex-end}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.3em}
.tail .left>div+div{margin-top:1em}
`;

  const kv = [
    d.number === null ? "" : `<tr><td>${numberLabel(d)}</td><td>${esc(String(d.number))}</td></tr>`,
    d.issueDate ? `<tr><td>Date</td><td>${when(d.issueDate)}</td></tr>` : "",
    isReceipt(d) && d.receipt
      ? `<tr><td>Paid on</td><td>${when(d.receipt.paidOn)}</td></tr>`
      : d.dueDate
        ? `<tr><td>${dueLabel(d)}</td><td>${when(d.dueDate)}</td></tr>`
        : "",
    d.businessTin ? `<tr><td>TIN</td><td>${esc(d.businessTin)}</td></tr>` : "",
  ].join("");

  const lines = d.lines
    .map(
      (l) => `<tr><td class="nm">${esc(l.description)}</td><td class="r">${qty(l.qty)}</td>
      <td class="r">${money(l.unitAmountKobo)}</td><td class="r">${money(l.amountKobo)}</td></tr>`,
    )
    .join("");

  const tot = (k: string, v: string, cls = "") => `<tr class="${cls}"><td>${k}</td><td>${v}</td></tr>`;

  const body = `<div class="wrap">
  <div class="lh">
    ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
    <p class="biz">${esc(d.businessName)}</p>
    ${bizMeta(d, ["address", "email"]) ? `<p class="meta">${bizMeta(d, ["address", "email"]).replace(/<br>/g, " &middot; ")}</p>` : ""}
  </div>
  <div class="r1"></div><div class="r2"></div>

  <div class="head">
    <div class="min0">
      <h1>${kind(d)}</h1>
      <div class="to">${billedTo(d)}</div>
    </div>
    ${kv ? `<table class="kv">${kv}</table>` : ""}
  </div>

  ${d.title ? `<div style="margin-top:1.3em">${titleBlock(d, "margin:0")}</div>` : ""}
  <table class="tbl">
    <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="tot">
    ${tot("Subtotal", money(d.subtotalKobo))}
    ${tot(`VAT (${d.vatPercent ?? 0}%)`, money(d.vatKobo))}
    ${part ? tot("Paid", `&minus;${money(d.amountPaidKobo)}`) : ""}
    ${tot(h.label, h.display, "g")}
  </table>
  <div class="fxw">${fxNote(d)}</div>

  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.5,
    brand: (k) => `.tot tr.g td{background:${k.c};color:${k.on};border-color:${k.c}}.tbl th{background:${k.wash}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Bento                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every fact in its own rounded tile, the amount on the one dark tile, laid
 * out like a product page. Modern, and still nothing to hunt for.
 */
function bento(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.5em;gap:.55em}
.g{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.55em}
.t{background:#F3EEE4;border-radius:.95em;padding:1em 1.1em;min-width:0}
.t.s2{grid-column:span 2}
.t.all{grid-column:1 / -1}
.t.dk{background:${INK};color:${CREAM};display:flex;flex-direction:column}
.t.dk .due{margin-top:auto}
.t.dk .cap,.t.dk .fx,.t.dk .fx b{color:inherit}
.t.dk .cap,.t.dk .fx{opacity:.65}
.t.dk .due.paid .amt{color:inherit}
.t.wh{background:#fff;box-shadow:inset 0 0 0 1px ${ink(0.1)}}
.t.grow{flex:1}
.id{display:flex;flex-direction:column;min-height:8.4em}
.id .meta{margin-top:.4em}
.id .kd{margin-top:auto;padding-top:1em;display:flex;align-items:baseline;gap:.6em}
.id .kd b{font-family:${DISPLAY};font-size:2em;line-height:1;font-weight:800;letter-spacing:-.055em}
.id .kd span{font-size:.62em;color:${ink(0.5)}}
.row{display:flex;gap:.55em}
.row>.t{flex:1}
.tail{display:flex;align-items:flex-end;justify-content:space-between;gap:1em}
.foot{padding:0 .3em}
`;

  const dates = [d.issueDate ? field("Issued", when(d.issueDate)) : "", dueField(d)].filter(Boolean);

  const body = `<div class="wrap">
  <div class="g">
    <div class="t s2 id">
      ${biz(d)}
      ${bizMeta(d) ? `<p class="meta">${metaLine(d)}</p>` : ""}
      <div class="kd"><b>${kind(d)}</b><span>${no(d)}</span></div>
    </div>
    <div class="t dk">${due(d, { size: `${fit(h.display, 1.7, 6.6)}em` })}</div>
  </div>

  <div class="g">
    <div class="t">${billedTo(d, null)}</div>
    ${dates.map((f) => `<div class="t">${f}</div>`).join("")}
    ${dates.length < 2 ? `<div class="t${dates.length ? "" : " s2"}">${payInfo(d) || field("From", esc(d.businessName))}</div>` : ""}
  </div>

  <div class="t wh grow">${titleBlock(d)}${rows(d)}</div>

  <div class="row">
    ${dates.length >= 2 && payInfo(d) ? `<div class="t">${payInfo(d)}</div>` : ""}
    ${d.notes ? `<div class="t">${notesBlock(d)}</div>` : ""}
    <div class="t" style="flex:0 0 13.4em">${sums(d)}</div>
  </div>

  ${signature(d) ? `<div class="tail"><span></span>${signature(d)}</div>` : ""}
  <div class="foot">
    ${legal(d)}
    ${made(d)}
  </div>
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.0,
    brand: (k) => `.t.dk{background:${k.c};color:${k.on}}.t{background:${k.wash}}.t.wh{background:#fff}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Adire                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A band of adire across the head and foot of the page: the resist-dyed
 * cloth of Abeokuta, its circles, dots and ladders drawn in line. The one
 * that could only have come from here.
 *
 * Drawn as an inline SVG pattern rather than an image, so it is a few hundred
 * bytes, sharp at any size, and coloured by CSS: ink by default, theirs on a
 * brand colour.
 */
const ADIRE = (id: string) => `<svg class="cloth" aria-hidden="true"><defs>
<pattern id="${id}" width="48" height="48" patternUnits="userSpaceOnUse">
<rect width="48" height="48" fill="currentColor"/>
<g class="m" fill="none" stroke-width="1.6">
<circle cx="24" cy="24" r="12"/><circle cx="24" cy="24" r="6.5"/>
<path d="M0 0l9 9M48 0l-9 9M0 48l9-9M48 48l-9-9"/>
<path d="M24 0v5M24 43v5M0 24h5M43 24h5"/></g>
<g class="d"><circle cx="24" cy="24" r="2"/><circle cx="24" cy="10" r="1.3"/><circle cx="24" cy="38" r="1.3"/>
<circle cx="10" cy="24" r="1.3"/><circle cx="38" cy="24" r="1.3"/></g>
</pattern></defs><rect width="100%" height="100%" fill="url(#${id})"/></svg>`;

function adire(d: DocumentData, opts: RenderOptions): string {
  const css = `
.cloth{display:block;width:100%;height:100%;color:${INK}}
.cloth .m{stroke:${CREAM}}
.cloth .d{fill:${MARIGOLD}}
.band{flex:none;height:3.3em}
.band.b{height:1.1em}
.wrap{flex:1;display:flex;flex-direction:column;padding:1.5em 1.9em 1.3em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.top .meta{margin-top:.35em}
.kd{flex:none;text-align:right}
.kd h1{font-family:${DISPLAY};font-size:2.1em;line-height:1;font-weight:800;letter-spacing:-.05em}
.kd p{margin-top:.35em;font-size:.58em;color:${ink(0.55)}}
.facts{margin-top:1.5em;display:flex;gap:1.4em;border-top:1px solid ${ink(0.15)};border-bottom:1px solid ${ink(0.15)};padding:.8em 0}
.facts>div{min-width:0;flex:1}
.facts>div:first-child{flex:1.6}
.work{margin-top:1.3em}
.money{margin-top:1.3em;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em}
.money .sums{width:12em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const body = `<div class="band">${ADIRE("adire-t")}</div>
<div class="wrap">
  <div class="top">
    <div class="min0">
      ${biz(d)}
      ${bizMeta(d) ? `<p class="meta">${bizMeta(d)}</p>` : ""}
    </div>
    <div class="kd">
      <h1>${kind(d)}</h1>
      <p>${[no(d), d.issueDate ? when(d.issueDate) : ""].filter(Boolean).join(" &middot; ")}</p>
    </div>
  </div>

  <div class="facts">
    ${billedTo(d)}
    ${dueField(d)}
    ${namesWork(d) && !d.title ? field("Work", esc(headline(d))) : ""}
  </div>

  <div class="work">${titleBlock(d)}${rows(d, { head: "bar" })}</div>
  <div class="money">
    ${due(d)}
    ${sums(d)}
  </div>

  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>
<div class="band b">${ADIRE("adire-b")}</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.5,
    brand: (k) => `.cloth{color:${k.c}}.cloth .m{stroke:${k.on}}.cloth .d{fill:${k.on}}.rows .hd.bar{background:${k.c};color:${k.on}}.kd h1{color:${k.deep}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Slip                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A long paper slip down the middle of the page, torn at both ends: the shape
 * of a till receipt, set like a good one. Everything centred, the amount once
 * and large, the work as leader lines.
 */
function slip(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const tear = (side: "top" | "bottom") =>
    `.slip::${side === "top" ? "before" : "after"}{content:"";position:absolute;left:0;right:0;${side}:-.6em;height:.6em;
background:linear-gradient(${side === "top" ? "-45deg" : "45deg"},#fff .42em,transparent 0),linear-gradient(${side === "top" ? "45deg" : "-45deg"},#fff .42em,transparent 0);
background-size:1.2em 1.2em;background-position:${side === "top" ? "left bottom" : "left top"};background-repeat:repeat-x}`;

  const css = `
.sheet{background:#EEE8DC}
.wrap{flex:1;display:flex;justify-content:center;padding:1.2em 0}
.slip{position:relative;width:21em;background:#fff;display:flex;flex-direction:column;padding:1.3em 1.6em 1.1em;text-align:center}
${tear("top")}
${tear("bottom")}
.slip .accent{width:2.2em;height:.24em;margin:0 auto .9em;background:${MARIGOLD};border-radius:9em}
.slip .logo{justify-content:center}
.slip .meta{margin-top:.35em}
.hr{margin:.8em 0;border-top:.1em dashed ${ink(0.25)}}
.kd{font-size:.56em;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:${ink(0.5)}}
.lbl{margin-top:.6em}
.amt{margin-top:.2em;font-family:${DISPLAY};font-size:${fit(h.display, 2.3, 15.5)}em;line-height:1;font-weight:800;
letter-spacing:-.045em;font-variant-numeric:tabular-nums;white-space:nowrap}
.slip .fx{margin:.6em auto 0;text-align:center}
.wh{margin-top:.55em;font-size:.6em;color:${ink(0.6)}}
.li{display:flex;align-items:baseline;gap:.5em;text-align:left;font-size:.62em;padding:.28em 0}
.li .nm{min-width:0;flex:1}
.li .nm b{font-weight:600}
.li .nm small{display:block;font-size:.88em;color:${ink(0.5)}}
.li .a{white-space:nowrap;font-weight:600;font-variant-numeric:tabular-nums}
.slip .sums{text-align:left}
.kvs{margin-top:.9em;display:flex;justify-content:center;gap:1.4em}
.kvs>div{min-width:0}
.slip .pay{margin-top:.8em}
.slip .nb{text-align:left}
.slip .sig{margin:1.2em auto 0}
.slip .legal{text-align:center}
.slip .made{justify-content:center;margin-top:.6em}
.bot{margin-top:auto}
`;

  const list = d.lines
    .map(
      (l) => `<div class="li"><span class="nm"><b>${esc(l.description)}</b>${
        l.qty === 1 ? "" : `<small>${qty(l.qty)} &times; ${money(l.unitAmountKobo)}</small>`
      }</span><span class="a">${money(l.amountKobo)}</span></div>`,
    )
    .join("");

  const kvs = [
    billedTo(d, null),
    d.issueDate ? field("Issued", when(d.issueDate)) : "",
    isReceipt(d) && d.receipt
      ? field("Paid by", esc(methodWords(d.receipt.method)))
      : d.dueDate
        ? field(dueLabel(d), when(d.dueDate))
        : "",
  ].join("");

  const whenLine =
    isReceipt(d) && d.receipt
      ? `Paid ${when(d.receipt.paidOn)}`
      : d.dueDate && !h.paid
        ? `${dueLabel(d)} ${when(d.dueDate)}`
        : "";

  const body = `<div class="wrap"><div class="slip">
  <div class="accent"></div>
  ${biz(d)}
  ${bizMeta(d) ? `<p class="meta">${metaLine(d)}</p>` : ""}

  <div class="hr"></div>
  <p class="kd">${kind(d)}${d.number === null ? "" : ` &middot; ${no(d)}`}</p>
  ${d.title ? `<p style="margin-top:.5em;font-weight:700;font-size:.8em">${esc(d.title)}</p>` : ""}
  <div class="lbl">${cap(h.label)}</div>
  <p class="amt">${h.display}</p>
  ${fxNote(d)}
  ${whenLine ? `<p class="wh">${whenLine}</p>` : ""}
  <div class="kvs">${kvs}</div>

  <div class="hr"></div>
  ${list}
  <div class="hr"></div>
  ${sums(d)}
  ${payInfo(d)}
  ${notesBlock(d, "nb")}
  ${signature(d)}

  <div class="bot">
    ${legal(d)}
    ${d.showMadeWith ? madeWith(d) : ""}
  </div>
</div></div>`;

  return sheet(d, opts, { css, body, rowEm: 3.0, logoEm: 1.2 });
}

/* -------------------------------------------------------------------------- */
/* Angle                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Two cut triangles in the top corner and a slanted band along the foot. The
 * modern-corporate shape, kept to the edges so the middle stays plain paper.
 */
function angle(d: DocumentData, opts: RenderOptions): string {
  const css = `
.c1{position:absolute;top:0;right:0;width:14em;height:11.5em;background:${MARIGOLD};clip-path:polygon(0 0,100% 0,100% 100%)}
.c2{position:absolute;top:0;right:0;width:8.6em;height:7em;background:${INK};clip-path:polygon(0 0,100% 0,100% 100%)}
.base{position:absolute;left:0;right:0;bottom:0;height:1.3em;background:${INK};clip-path:polygon(0 70%,100% 0,100% 100%,0 100%)}
.base2{position:absolute;left:0;right:0;bottom:0;height:2.1em;background:${MARIGOLD};clip-path:polygon(0 86%,100% 0,100% 100%,0 100%)}
.wrap{position:relative;flex:1;display:flex;flex-direction:column;padding:1.7em 2em 2.5em}
.who{max-width:15em}
.who .logo{flex-direction:column;align-items:flex-start;gap:.5em;min-width:0}
.who .logo img{height:2.3em}
.who .meta{margin-top:.35em}
h1{margin-top:.9em;font-family:${DISPLAY};font-size:2.6em;line-height:.9;font-weight:800;letter-spacing:-.055em}
.subl{margin-top:.5em;font-size:.6em;color:${ink(0.55)}}
.facts{margin-top:1.2em;display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:1em}
.facts>div{border-top:.18em solid ${MARIGOLD};padding-top:.6em;min-width:0}
.work{margin-top:1.2em}
.money{margin-top:1em;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em}
.money .sums{width:12em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const body = `<div class="c1"></div><div class="c2"></div><div class="base2"></div><div class="base"></div>
<div class="wrap">
  <div class="who">
    ${biz(d)}
    ${bizMeta(d) ? `<p class="meta">${bizMeta(d)}</p>` : ""}
  </div>
  <h1>${kind(d)}</h1>
  <p class="subl">${[no(d), d.issueDate ? `Issued ${when(d.issueDate)}` : ""].filter(Boolean).join(" &middot; ")}</p>

  <div class="facts">
    ${billedTo(d)}
    ${dueField(d) || "<div></div>"}
    ${field("Amount", headlineAmount(d).display)}
  </div>

  <div class="work">${titleBlock(d)}${rows(d, { head: "bar" })}</div>
  <div class="money">
    ${due(d)}
    ${sums(d)}
  </div>

  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 3.2,
    logoEm: 2.6,
    brand: (k) => `.c2,.base{background:${k.deep}}.rows .hd.bar{background:${k.deep};color:#fff}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Meridian                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The corporate one: a solid band carrying the reference facts, striped rows,
 * and the total in a boxed bar. What a large client's accounts team expects
 * an invoice to look like.
 */
function meridian(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const css = `
.wrap{flex:1;display:flex;flex-direction:column}
.head{display:flex;justify-content:space-between;align-items:center;gap:1em;padding:1.5em 1.9em 1.1em}
.head .logo{flex-direction:column;align-items:flex-start;gap:.4em;min-width:0}
.head .logo img{height:2.4em}
.head h1{flex:none;font-family:${DISPLAY};font-size:2.3em;line-height:1;font-weight:800;letter-spacing:-.045em}
.band{display:flex;gap:1.4em;background:${INK};color:${CREAM};padding:.85em 1.9em}
.band>div{flex:1;min-width:0}
.band .cap,.band .fv{color:inherit}
.band .cap{opacity:.6}
.body{flex:1;display:flex;flex-direction:column;padding:1.4em 1.9em 1.2em}
.parties{display:flex;gap:1.4em}
.parties>div{flex:1;min-width:0}
.parties .meta{margin-top:.35em}
.zebra{margin-top:1.4em}
.zebra .rows .it{border-bottom:0;padding-left:.9em;padding-right:.9em}
.zebra .rows .it:nth-child(odd){background:${CREAM}}
.box{margin-left:auto;margin-top:1em;width:14em}
.box .sums{padding:0 .9em}
.gt{display:flex;align-items:center;justify-content:space-between;gap:1em;background:${INK};color:${CREAM};padding:.7em .9em;margin-top:.3em}
.gt .k{font-size:.58em;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.gt .v{font-family:${DISPLAY};font-size:1.25em;line-height:1;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;white-space:nowrap}
.box .fx{margin-top:.5em}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
.fband{flex:none;height:.55em;background:${MARIGOLD}}
`;

  const facts = [
    d.number === null ? "" : field(numberLabel(d), esc(String(d.number))),
    d.issueDate ? field("Issued", when(d.issueDate)) : "",
    dueField(d),
    field(h.label, h.display),
  ].filter(Boolean);

  const body = `<div class="wrap">
  <div class="head">
    ${biz(d)}
    <h1>${kind(d)}</h1>
  </div>
  <div class="band">${facts.join("")}</div>

  <div class="body">
    <div class="parties">
      <div>${field("From", esc(d.businessName))}${bizMeta(d) ? `<p class="meta">${bizMeta(d)}</p>` : ""}</div>
      ${billedTo(d)}
    </div>

    <div class="zebra">${titleBlock(d)}${rows(d, { head: "bar" })}</div>

    <div class="box">
      ${sums(d)}
      <div class="gt"><span class="k">${h.label}</span><span class="v">${h.display}</span></div>
      ${fxNote(d)}
    </div>

    <div class="tail">
      <div class="left">${payInfo(d)}${notesBlock(d)}</div>
      ${signature(d)}
    </div>
    ${legal(d)}
    ${made(d)}
  </div>
  <div class="fband"></div>
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.9,
    brand: (k) =>
      `.band,.gt,.rows .hd.bar{background:${k.c};color:${k.on}}.zebra .rows .it:nth-child(odd){background:${k.wash}}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Monogram                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The business's initials set enormous in the corner, the rest of the page
 * quiet, and the amount in an outlined pill. Their own logo takes the
 * monogram's place when they have one: one mark at the top, and it is theirs.
 */
function monogram(d: DocumentData, opts: RenderOptions): string {
  const h = headlineAmount(d);
  const css = `
.wrap{flex:1;display:flex;flex-direction:column;padding:1.8em 2em 1.4em}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em}
.mg{font-family:${DISPLAY};font-size:5.6em;line-height:.76;font-weight:800;letter-spacing:-.07em;color:${MARIGOLD}}
.mgimg{display:block;width:auto;height:4em;max-width:13em;object-fit:contain;object-position:left center}
.kd{flex:none;text-align:right}
.kd .k{font-size:.62em;font-weight:700;letter-spacing:.32em;text-transform:uppercase}
.kd .n{margin-top:.35em;font-size:.58em;color:${ink(0.5)}}
.who{margin-top:1.3em}
.who .nm{font-size:1.05em;font-weight:700}
.who .meta{margin-top:.25em}
.line{margin-top:1.2em;height:1px;background:${INK}}
.facts{margin-top:1em;display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:1.2em}
.work{margin-top:1.6em}
.owe{margin-top:1.4em;display:flex;align-items:center;justify-content:space-between;gap:1.2em}
.owe .sums{width:12em}
.pillbox{display:flex;align-items:center;gap:1em;border:.12em solid ${INK};border-radius:99em;padding:.65em .7em .65em 1.3em}
.pillbox .cap{white-space:nowrap}
.pillbox .v{font-family:${DISPLAY};font-size:${fit(h.display, 1.6, 9)}em;line-height:1;font-weight:800;letter-spacing:-.04em;
font-variant-numeric:tabular-nums;white-space:nowrap;background:${MARIGOLD};border-radius:99em;padding:.3em .55em}
.fxr{display:flex;justify-content:flex-end}
.tail{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:1.2em;padding-top:1.2em}
.tail .left>div+div{margin-top:1em}
`;

  const body = `<div class="wrap">
  <div class="top">
    ${d.logoDataUri ? `<img class="mgimg" src="${d.logoDataUri}" alt="">` : `<p class="mg">${esc(initials(d.businessName))}</p>`}
    <div class="kd">
      <p class="k">${kind(d)}</p>
      <p class="n">${[no(d), d.issueDate ? when(d.issueDate) : ""].filter(Boolean).join(" &middot; ")}</p>
    </div>
  </div>
  <div class="who">
    <p class="nm">${esc(d.businessName)}</p>
    ${bizMeta(d) ? `<p class="meta">${metaLine(d)}</p>` : ""}
  </div>
  <div class="line"></div>

  <div class="facts">
    ${billedTo(d)}
    ${d.issueDate ? field("Issued", when(d.issueDate)) : "<div></div>"}
    ${dueField(d) || "<div></div>"}
  </div>

  <div class="work">${titleBlock(d)}${rows(d)}</div>

  <div class="owe">
    ${sums(d)}
    <div class="pillbox">${cap(h.label)}<span class="v">${h.display}</span></div>
  </div>
  <div class="fxr">${fxNote(d)}</div>

  <div class="tail">
    <div class="left">${payInfo(d)}${notesBlock(d)}</div>
    ${signature(d)}
  </div>
  ${legal(d)}
  ${made(d)}
</div>`;

  return sheet(d, opts, {
    css,
    body,
    rowEm: 2.6,
    brand: (k) => `.mg{color:${k.deep}}.pillbox .v{color:${k.on}}.line,.pillbox{border-color:${k.c}}`,
  });
}

/* -------------------------------------------------------------------------- */

export const PLUS_RENDERERS = {
  swiss,
  gazette,
  blueprint,
  poster,
  ticket,
  letterhead,
  bento,
  adire,
  slip,
  angle,
  meridian,
  monogram,
} satisfies Record<string, (d: DocumentData, opts: RenderOptions) => string>;
