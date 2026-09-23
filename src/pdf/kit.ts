/**
 * The parts every invoice layout is built from.
 *
 * These are a direct port of the sheets on balans.ng — the same rules, the
 * same type sizes, the same hairlines, in plain CSS instead of Tailwind. The
 * landing page is what a user has seen before they choose a design, so the
 * document they get has to be that drawing and not an approximation of it.
 *
 * Three things make the port exact rather than approximate:
 *
 *   - Every length is in `em`, as on the web, so one `font-size` on the sheet
 *     scales a whole document. A4 is 28.33em wide there (a 340px preview at
 *     12px), which is 7.41mm per em on a 210mm page.
 *   - The type is the web app's own — Instrument Sans and Geist, carried in
 *     the repository rather than borrowed from the host. See `fonts.ts`.
 *   - Where a marketing sheet showed something a real document does not have
 *     — an invented project name, a drawn signature — the shape is kept and
 *     the content comes from the document. Nothing is made up. A forged
 *     signature on somebody's invoice is not a design decision.
 */

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { esc } from "../documents/page.ts";
import { FONT, fontFaces, type FontSet } from "./fonts.ts";
import type { DocumentData } from "./template.ts";

/** The display stack, for the layouts that set a number or a word large. */
export const DISPLAY = FONT.display;

export const INK = "#10231C";
export const MARIGOLD = "#F5B82E";
export const MARIGOLD_DEEP = "#D99A12";
export const CREAM = "#F6F1E7";
export const MOSS = "#3F8F5F";

/** `text-ink/45` and friends, which is how the web sheets state every tint. */
export const ink = (alpha: number): string => `rgba(16,35,28,${alpha})`;

export const money = (kobo: number): string => formatNaira(kobo);
export const when = (d: Civil | null): string => (d ? formatFriendly(d) : "—");

/* -------------------------------------------------------------------------- */
/* How big the sheet is set                                                   */
/* -------------------------------------------------------------------------- */

/** 210mm / 28.333em — the web sheet's own ratio, on a real A4 page. */
const EM_MM = 7.4118;

/** The sheet is 40.07em tall at that size, and everything has to fit in it. */
const SHEET_EM = 297 / EM_MM;

/**
 * The font-size the sheet is set at.
 *
 * The marketing sheets carry three line items and no notes, which is a
 * comfortable page. A real invoice can carry fifteen, and a fixed size would
 * either run off the bottom or be set small enough for fifteen on every
 * invoice that has three.
 *
 * So the page shrinks only when it has to. There is room for six rows before
 * anything has to give, and what each row beyond that costs depends on how
 * the layout sets them — a numbered row is 1.5em, Atelier's serif leaders
 * with a quantity under them are nearer 2.4em. The floor is 58%, which is
 * around 8pt body text: below that a layout stops being worth preserving and
 * the document should be two pages instead.
 *
 * PRD-GAP: a document with more work on it than fits at 58% is still cut off.
 * The fix is a second page that repeats the header, which needs the renderer
 * to measure rather than estimate.
 */
export function sheetFontSize(d: DocumentData, rowEm = 1.5): string {
  const rows = Math.max(0, d.lines.length - 6) * rowEm;
  const notes = d.notes ? 2 : 0;
  const receipt = d.receipt ? 1.5 : 0;
  const scale = Math.min(1, Math.max(0.58, SHEET_EM / (SHEET_EM + rows + notes + receipt)));
  return `${(EM_MM * scale).toFixed(3)}mm`;
}

/* -------------------------------------------------------------------------- */
/* The shared stylesheet                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything the eight layouts have in common.
 *
 * Class names match the pieces below, and each layout adds its own rules after
 * these. Nothing here is a reset for its own sake: an invoice is printed, and
 * `print-color-adjust` is what keeps an ink block from arriving as white paper
 * with white type on it.
 */
const BASE = `
@page{size:A4;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;color:${INK};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{
  position:relative;display:flex;flex-direction:column;overflow:hidden;
  width:210mm;height:297mm;background:#fff;
  font-family:${FONT.sans};line-height:1.45;
  -webkit-font-smoothing:antialiased;
}
.row{display:flex}
.tnum{font-variant-numeric:tabular-nums}
.min0{min-width:0}
.auto{margin-top:auto}

/* Labels, fields and the business block ---------------------------------- */
.cap{font-size:.58em;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:${ink(0.4)}}
.fv{margin-top:.35em;font-size:.68em;font-weight:600}
.fv .sub{display:block;font-weight:400;overflow-wrap:anywhere;color:${ink(0.5)}}
.logo{display:flex;align-items:center;gap:.55em}
.logo img{display:block;width:auto;max-width:9em;height:1.9em;object-fit:contain}
.logo .biz{font-size:1.05em;line-height:1.2;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:.6em;line-height:1.55;color:${ink(0.5)}}

/* The work, as the two Free layouts set it ------------------------------- */
.items{font-size:.66em}
.items .hd{display:flex;gap:1em;border-bottom:1px solid ${ink(0.15)};padding-bottom:.5em;
letter-spacing:.06em;text-transform:uppercase;color:${ink(0.4)}}
.items .hd span>span{font-size:.88em}
.items .it{display:flex;gap:1em;border-bottom:1px solid ${ink(0.08)};padding:.6em 0}
.items .nm{min-width:0;flex:1}
.items .nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.items .q{width:2em;text-align:right}
.items .u{width:4.4em;text-align:right}
.items .a{width:4.8em;text-align:right;font-weight:600}

/* Totals, as the two Free layouts set them ------------------------------- */
.totals{margin-left:auto;margin-top:.9em;width:12.6em;font-size:.66em}
.totals p{display:flex;justify-content:space-between;gap:.9em;padding:.35em 0}
.totals p span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${ink(0.55)}}
.totals p.sum{margin-top:.3em;border-top:1px solid ${ink(0.25)};padding-top:.6em}
.totals p.sum span:first-child{font-weight:600;color:${INK}}
.totals p.sum span:last-child{font-weight:800}
.totals p.gold span:last-child{font-size:1.15em;color:${MARIGOLD_DEEP}}
.totals p.off span:last-child{color:${MOSS}}

/* The work, as the six Pro layouts set it -------------------------------- */
.rows{font-size:.6em}
.rows .hd{display:flex;gap:1em;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.rows .hd span>span{font-size:.82em}
.rows .hd.rule{border-bottom:.12em solid ${INK};padding-bottom:.6em;color:${ink(0.5)}}
.rows .hd.bar{background:${INK};color:${CREAM};padding:.75em .9em}
.rows .it{display:flex;gap:1em;border-bottom:1px solid ${ink(0.1)};padding:.65em 0}
.rows.bar .it{padding-left:.9em;padding-right:.9em}
.rows .n{width:1.6em}
.rows .it .n{color:${ink(0.35)}}
.rows .nm{min-width:0;flex:1}
.rows .nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.rows .nm i{display:block;margin-top:.15em;font-size:.88em;font-style:normal;color:${ink(0.45)};
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rows .u{width:4.6em;text-align:right}
.rows .q{width:1.6em;text-align:right}
.rows .it .u,.rows .it .q{color:${ink(0.6)}}
.rows .a{width:5em;text-align:right;font-weight:600}

/* Subtotal and tax, small, for beside a stated total --------------------- */
.sums{font-size:.58em}
.sums p{display:flex;justify-content:space-between;gap:1.2em;padding-bottom:.45em;white-space:nowrap}
.sums p span:first-child{color:${ink(0.5)}}
.sums p.sum{border-top:1px solid ${ink(0.25)};padding-top:.45em;font-weight:600}
.sums p.sum span:first-child{color:inherit}

/* The amount, set like a headline ---------------------------------------- */
.due .amt{margin-top:.15em;font-family:${FONT.display};font-size:1.9em;line-height:1;
font-weight:800;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.due.paid .amt{color:${MOSS}}

/* How to pay -------------------------------------------------------------- */
.pay .url{font-size:.66em;font-weight:700;overflow-wrap:anywhere;
text-decoration:underline;text-decoration-color:${MARIGOLD};text-decoration-thickness:.14em;
text-underline-offset:.22em}
.pay .lbl+.url{margin-top:.45em}
.pay .how{margin-top:.4em;font-size:.54em;line-height:1.5;color:${ink(0.55)}}
.nb{margin-top:1em}
.note{margin-top:.45em;font-size:.54em;line-height:1.55;color:${ink(0.55)};white-space:pre-wrap}

/* Where a signature goes -------------------------------------------------- */
.sig{width:8.4em}
.sig .space{height:2.3em}
.sig .who{border-top:1px solid ${ink(0.5)};padding-top:.4em;font-size:.56em}
.sig .who b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sig .who span{display:block;opacity:.5}

/* The small print section 12 requires ------------------------------------ */
.legal{margin-top:.9em;padding-top:.7em;border-top:1px solid ${ink(0.1)};
font-size:.46em;line-height:1.6;color:${ink(0.42)}}
.made{display:flex;align-items:center;gap:.4em;white-space:nowrap;font-size:.58em;color:${ink(0.45)}}
.made svg{display:block;width:1.1em;height:1.1em;flex:none}

.mark{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);
font-family:${FONT.display};font-size:5.2em;font-weight:800;letter-spacing:.06em;
color:${ink(0.07)};white-space:nowrap}
`;

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export type RenderOptions = {
  /**
   * `embed` carries the typefaces in the HTML, which a PDF render needs
   * because it is given no origin to fetch from. `link` points at the fonts
   * route, for the picker, where eight sheets on one page would otherwise
   * carry eight copies of them.
   */
  fonts?: "embed" | "link";
};

type SheetParts = {
  css: string;
  body: string;
  /** Only the typefaces this layout sets anything in. */
  fonts?: FontSet[];
  /** What one line item costs this layout, for `sheetFontSize`. */
  rowEm?: number;
};

/** Wraps a layout's markup in a sheet, with only the typefaces it uses. */
export function sheet(d: DocumentData, opts: RenderOptions, parts: SheetParts): string {
  const { css, body, fonts = ["sans", "display"], rowEm } = parts;
  const link =
    opts.fonts === "link" ? `<link rel="stylesheet" href="/designs/fonts.css">` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${link}
<style>${fontFaces(fonts, opts.fonts ?? "embed")}${BASE}${css}</style></head>
<body><div class="sheet" style="font-size:${sheetFontSize(d, rowEm)}">
${d.variant === "sample" ? `<div class="mark">SAMPLE</div>` : ""}
${body}
</div></body></html>`;
}

/* -------------------------------------------------------------------------- */
/* Words the layouts agree on                                                 */
/* -------------------------------------------------------------------------- */

const UPPER: Record<DocumentData["variant"], string> = {
  invoice: "INVOICE",
  quote: "QUOTE",
  receipt: "RECEIPT",
  sample: "INVOICE",
};

const TITLE_CASE: Record<DocumentData["variant"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  receipt: "Receipt",
  sample: "Invoice",
};

export const upperKind = (d: DocumentData): string => UPPER[d.variant];
export const kind = (d: DocumentData): string => TITLE_CASE[d.variant];
export const isReceipt = (d: DocumentData): boolean => d.variant === "receipt";

export const dueLabel = (d: DocumentData): string => (d.variant === "quote" ? "Valid until" : "Due");
export const numberLabel = (d: DocumentData): string =>
  d.variant === "quote" ? "Quote no." : "Invoice no.";

/** What is left to pay, which is the number a client is looking for. */
export const owedKobo = (d: DocumentData): number => d.totalKobo - d.amountPaidKobo;

/** The headline amount, and what to call it. */
export function headlineAmount(d: DocumentData): { label: string; amount: number; paid: boolean } {
  if (isReceipt(d)) return { label: "Amount paid", amount: d.amountPaidKobo, paid: true };
  const owed = owedKobo(d);
  if (d.totalKobo > 0 && owed <= 0) return { label: "Paid in full", amount: d.totalKobo, paid: true };
  if (d.variant === "quote") return { label: "Quoted", amount: d.totalKobo, paid: false };
  return { label: "Total due", amount: owed, paid: false };
}

/**
 * The line a layout can set large.
 *
 * The marketing sheets carried a project name. A document has no such field,
 * and inventing one would print words the user never wrote. One line item is
 * the job and naming it reads exactly right; several are not, so those fall
 * back to the client, which is true of every invoice ever written.
 */
export const headline = (d: DocumentData): string =>
  d.lines.length === 1 ? d.lines[0]!.description : d.clientName;

/** Whether `headline` is naming the work rather than repeating the client. */
export const namesWork = (d: DocumentData): boolean => d.lines.length === 1;

/** "1", "2.5" — never "2.500", which reads as a price. */
export const qty = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

const METHOD_WORDS: Record<string, string> = {
  CARD: "Card",
  ACCOUNT_TRANSFER: "Bank transfer",
  DIRECT_DEBIT: "Direct debit",
  USSD: "USSD",
  PHONE_NUMBER: "Phone number",
  CASH: "Cash",
};

export const methodWords = (method: string | null): string =>
  !method ? "Online" : (METHOD_WORDS[method] ?? method.toLowerCase().replace(/_/g, " "));

/* -------------------------------------------------------------------------- */
/* The pieces                                                                 */
/* -------------------------------------------------------------------------- */

export const cap = (text: string): string => `<p class="cap">${text}</p>`;

/** A label over a value, the unit every layout states a fact in. */
export function field(k: string, v: string, className = ""): string {
  return `<div class="${className}">${cap(k)}<p class="fv">${v}</p></div>`;
}

/** A name with a quieter line under it — an address, an email. */
export const party = (name: string, line: string | null): string =>
  `${esc(name)}${line ? `<span class="sub">${esc(line)}</span>` : ""}`;

/** The Balans coin, drawn rather than fetched. Ours, and only ever on our line. */
export const COIN = `<svg viewBox="0 0 120 120" aria-hidden="true">
<circle cx="60" cy="60" r="60" fill="${MARIGOLD}"/>
<rect x="38" y="18" width="15" height="82" rx="3" fill="${INK}"/>
<circle cx="68" cy="74" r="19" fill="none" stroke="${INK}" stroke-width="14"/>
<rect x="25" y="25" width="41" height="8" rx="2" fill="${INK}"/>
<rect x="25" y="38" width="41" height="8" rx="2" fill="${INK}"/></svg>`;

/**
 * The business, as a mark and a name.
 *
 * Their logo when they have one, and nothing at all when they do not — never
 * ours. This is their invoice to their client, and a Balans coin beside their
 * name reads as their mark, which it is not.
 */
export function biz(d: DocumentData, className = ""): string {
  return `<div class="logo ${className}">
    ${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="">` : ""}
    <p class="biz">${esc(d.businessName)}</p>
  </div>`;
}

/** Address, email, TIN — whichever of them the user has given us. */
export function bizMeta(d: DocumentData, fields: ("address" | "email" | "tin")[] = ["address", "email", "tin"]): string {
  const parts = fields
    .map((f) =>
      f === "address"
        ? d.businessAddress && esc(d.businessAddress)
        : f === "email"
          ? d.businessEmail && esc(d.businessEmail)
          : d.businessTin && `TIN ${esc(d.businessTin)}`,
    )
    .filter(Boolean);
  return parts.join("<br>");
}

/** The two Free layouts' table of work. */
export function items(d: DocumentData, opts: { rate?: boolean } = {}): string {
  const rate = opts.rate !== false;
  const head = `<div class="hd">
    <span class="nm"><span>Item detail</span></span>
    <span class="q"><span>Qty</span></span>
    ${rate ? `<span class="u"><span>Rate</span></span>` : ""}
    <span class="a"><span>Amount</span></span>
  </div>`;

  const rows = d.lines
    .map(
      (l) => `<div class="it">
      <span class="nm"><b>${esc(l.description)}</b></span>
      <span class="q tnum">${qty(l.qty)}</span>
      ${rate ? `<span class="u tnum">${money(l.unitAmountKobo)}</span>` : ""}
      <span class="a tnum">${money(l.amountKobo)}</span>
    </div>`,
    )
    .join("");

  return `<div class="items">${head}${rows}</div>`;
}

/**
 * The six Pro layouts' numbered rows.
 *
 * The column widths sit on the outer span and the label inside it is set
 * smaller, so a header lines up with the rows under it rather than drifting
 * by the difference between the two type sizes.
 */
export function rows(d: DocumentData, opts: { head?: "bar" | "rule"; rate?: boolean } = {}): string {
  const head = opts.head ?? "rule";
  const rate = opts.rate !== false;

  const header = `<div class="hd ${head}">
    <span class="n"><span>No</span></span>
    <span class="nm"><span>Description</span></span>
    ${rate ? `<span class="u"><span>Rate</span></span>` : ""}
    <span class="q"><span>Qty</span></span>
    <span class="a"><span>Amount</span></span>
  </div>`;

  const body = d.lines
    .map(
      (l, i) => `<div class="it">
      <span class="n tnum">${String(i + 1).padStart(2, "0")}</span>
      <span class="nm"><b>${esc(l.description)}</b></span>
      ${rate ? `<span class="u tnum">${money(l.unitAmountKobo)}</span>` : ""}
      <span class="q tnum">${qty(l.qty)}</span>
      <span class="a tnum">${money(l.amountKobo)}</span>
    </div>`,
    )
    .join("");

  return `<div class="rows ${head}">${header}${body}</div>`;
}

/** Subtotal, VAT and what is left, for the Free layouts' wide totals block. */
export function totals(d: DocumentData, opts: { accent?: "ink" | "marigold" } = {}): string {
  const gold = opts.accent === "marigold" ? " gold" : "";
  const owed = owedKobo(d);
  const part = !isReceipt(d) && d.amountPaidKobo > 0 && owed > 0;

  const line = (k: string, v: number, cls = "") =>
    `<p class="${cls}"><span>${k}</span><span class="tnum">${money(v)}</span></p>`;

  return `<div class="totals">
    ${line("Subtotal", d.subtotalKobo)}
    ${line(`VAT (${d.vatPercent ?? 0}%)`, d.vatKobo)}
    ${line(isReceipt(d) ? "Paid" : "Total", isReceipt(d) ? d.amountPaidKobo : d.totalKobo, `sum${part ? "" : gold}`)}
    ${part ? `<p class="off"><span>Paid</span><span class="tnum">&minus;${money(d.amountPaidKobo)}</span></p>` : ""}
    ${part ? line("Balance", owed, `sum${gold}`) : ""}
  </div>`;
}

/** The same figures, small, for beside a stated total. */
export function sums(d: DocumentData, className = ""): string {
  const owed = owedKobo(d);
  const part = !isReceipt(d) && d.amountPaidKobo > 0 && owed > 0;

  return `<div class="sums ${className}">
    <p><span>Subtotal</span><span class="tnum">${money(d.subtotalKobo)}</span></p>
    <p><span>VAT (${d.vatPercent ?? 0}%)</span><span class="tnum">${money(d.vatKobo)}</span></p>
    ${part ? `<p><span>Paid</span><span class="tnum">&minus;${money(d.amountPaidKobo)}</span></p>` : ""}
    <p class="sum"><span>${part ? "Balance" : "Grand total"}</span><span class="tnum">${money(
      part ? owed : d.totalKobo,
    )}</span></p>
  </div>`;
}

/** The amount, set like a headline. */
export function due(d: DocumentData, opts: { size?: string; label?: string; className?: string } = {}): string {
  const h = headlineAmount(d);
  const size = opts.size ? `font-size:${opts.size}` : "";
  return `<div class="due ${h.paid ? "paid" : ""} ${opts.className ?? ""}">
    ${cap(opts.label ?? h.label)}
    <p class="amt" style="${size}">${money(h.amount)}</p>
  </div>`;
}

/**
 * How to pay: the link, and nothing else to pay into.
 *
 * A bank account number on the document invites a transfer that skips the
 * link, and with it the split, the receipt and the message in WhatsApp that
 * says the money arrived. It is on none of these layouts on purpose.
 */
export function payInfo(d: DocumentData, opts: { label?: boolean; className?: string } = {}): string {
  if (!d.publicUrl || isReceipt(d) || owedKobo(d) <= 0) return "";
  const label = opts.label !== false;
  return `<div class="pay ${opts.className ?? ""}">
    ${label ? `<p class="cap lbl">Pay online</p>` : ""}
    <p class="url">${esc(shortUrl(d.publicUrl))}</p>
    <p class="how">Card, bank transfer or USSD<br>Protected by Monnify</p>
  </div>`;
}

/** The link as people read it out: no scheme, no trailing slash. */
export const shortUrl = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Whatever the user wrote on the document, under a Terms label. */
export function notesBlock(d: DocumentData, className = ""): string {
  if (!d.notes) return "";
  return `<div class="${className}">${cap("Terms")}<p class="note">${esc(d.notes)}</p></div>`;
}

/**
 * Where a signature goes.
 *
 * The marketing sheets had one drawn in. We have never been given the user's
 * signature and will not invent one, so what is left is the convention a
 * printed invoice already uses: a ruled space, the business under it, to be
 * signed if anybody needs it signed.
 */
export function signature(d: DocumentData, className = ""): string {
  return `<div class="sig ${className}">
    <div class="space"></div>
    <div class="who"><b>${esc(d.businessName)}</b><span>Authorised signature</span></div>
  </div>`;
}

/** The house line every Free document carries (PRD F9). */
export const madeWith = (d: DocumentData): string =>
  d.showMadeWith ? `<p class="made">${COIN}Made with Balans</p>` : "";

/** Section 12's two lines, on everything a client sees. */
export const legal = (d: DocumentData, className = ""): string =>
  `<div class="legal ${className}">${esc(d.legalLines[0])}<br>${esc(d.legalLines[1])}</div>`;
