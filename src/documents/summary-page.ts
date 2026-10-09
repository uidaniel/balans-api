/**
 * One page showing somebody everything they have invoiced.
 *
 * Reached from a "View Summary" button on /owed and /summary, which opens it
 * inside WhatsApp's own web view. That setting decides most of what follows:
 *
 *   - It is a phone, in a sheet narrower than the browser. One column, nothing
 *     that scrolls sideways, nothing that needs a hover.
 *   - There is nobody to log in as. The link is the credential and it expires;
 *     see `0019_summary_token.sql`.
 *   - Nothing it needs may be able to fail. WhatsApp's web view opens on
 *     whatever connection the chat arrived over, which in Lagos is often one
 *     bar of LTE. So there is no chart library and no analytics: the charts
 *     are hand-drawn SVG, a few hundred bytes inline, which cannot fail to
 *     load. The brand fonts are the one fetch, from our own origin and with
 *     `font-display: swap`, so a slow connection reads the page in the phone's
 *     own font rather than staring at a blank screen.
 *
 * The numbers are the ones somebody actually asks about, in the order they ask
 * them: what am I owed, who has it, and how am I doing. Anything cleverer than
 * that is a dashboard nobody opens twice.
 */

import { formatNaira } from "../../core/totals.ts";
import { formatFriendly, type Civil } from "../../core/dates.ts";
import { esc } from "./page.ts";
import { FONT, fontFacesForPage } from "../pdf/fonts.ts";

export type SummaryData = {
  businessName: string;
  /** Lifetime, across every document that ever went out. */
  invoicesSent: number;
  paidKobo: number;
  outstandingKobo: number;
  overdueKobo: number;
  /** Money in, by calendar month, oldest first. At most twelve. */
  months: { label: string; paidKobo: number }[];
  /** Who is sitting on money, most overdue first. */
  owing: {
    clientName: string;
    ref: string | null;
    number: number | null;
    outstandingKobo: number;
    dueDate: Civil | null;
    daysLate: number | null;
  }[];
  /** Their best clients by what they have actually paid. */
  clients: { name: string; paidKobo: number }[];
};

const MOSS = "#3F8F5F";
const MARIGOLD = "#F5B82E";
const CLAY = "#C2593F";

/** "₦1.25M", "₦930K", "₦4,500": for axes and tips, where the exact figure is noise. */
function compact(kobo: number): string {
  const n = kobo / 100;
  const cut = (v: number, unit: string) => `₦${Number(v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0))}${unit}`;
  if (n >= 1e9) return cut(n / 1e9, "B");
  if (n >= 1e6) return cut(n / 1e6, "M");
  if (n >= 1e4) return cut(n / 1e3, "K");
  return formatNaira(kobo);
}

/** A tick step that reads as a round number: 1, 2 or 5 of some power of ten. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "·";

/** A small figure with its label above it. */
const tile = (label: string, value: string, extra = ""): string =>
  `<div class="tile"><p class="k">${label}</p><p class="v">${esc(value)}</p>${extra}</div>`;

/**
 * Money in by month, as columns.
 *
 * Drawn rather than plotted. A chart library is tens of kilobytes over a
 * connection that may not finish, to draw twelve rectangles — and a page that
 * half-loads on a phone is worse than one that is plainer than it could have
 * been.
 *
 * The SVG has a fixed viewBox and scales evenly, so the rounded ends stay
 * round at any width. Everything that is text — the axis, the peak, the tips
 * — is HTML laid over it, so it stays at a readable size on a 320px phone
 * instead of shrinking with the drawing.
 *
 * Hover or tap a month for its figure. Pure CSS: each month has a focusable
 * strip over it, and its tip shows on hover or focus. The page carries no
 * script at all.
 *
 * An empty history says so in words rather than drawing twelve zero-height
 * bars, which read as a broken chart rather than as no history.
 */
function bars(months: SummaryData["months"]): string {
  if (!months.some((m) => m.paidKobo > 0)) {
    return `<p class="none">No payments yet. This fills in as clients pay you.</p>`;
  }

  const W = 600;
  const H = 200;
  const peak = Math.max(...months.map((m) => m.paidKobo), 1);
  const step = niceStep(peak / 3);
  const top = step * Math.ceil(peak / step);
  const slot = W / months.length;
  const bw = Math.min(28, slot * 0.56);
  const best = months.findIndex((m) => m.paidKobo === peak);

  const ticks = [0, 1, 2, 3]
    .map((i) => (top * i) / 3)
    .map((v) => ({ v, y: H - (v / top) * H }));

  const grid = ticks
    .map((t) => `<line x1="0" x2="${W}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" class="${t.v === 0 ? "base" : "g"}"/>`)
    .join("");

  const rects = months
    .map((m, i) => {
      /*
       * A month with nothing in it draws no bar at all, and keeps its label
       * on the axis below. The gap is the point: dropping the month entirely
       * would close it up and make a quiet quarter look busy.
       *
       * Everything else gets a floor, so a month with a little money is
       * visibly different from a month with none.
       */
      if (m.paidKobo <= 0) return "";
      const h = Math.max(4, (m.paidKobo / top) * H);
      const x = i * slot + (slot - bw) / 2;
      const y = H - h;
      const r = Math.min(4, bw / 2, h);
      // Rounded at the data end, square on the baseline.
      return (
        `<rect data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" ` +
        `rx="${r}" class="${i === best ? "pk" : ""}"/>` +
        `<path d="M${x.toFixed(1)} ${(H - Math.min(h, r)).toFixed(1)}h${bw.toFixed(1)}V${H}H${x.toFixed(1)}Z" data-i="${i}"/>`
      );
    })
    .join("");

  const axis = ticks
    .filter((t) => t.v > 0)
    .map((t) => `<p class="yl" style="top:${((t.y / H) * 100).toFixed(2)}%">${esc(compact(t.v))}</p>`)
    .join("");

  const hits = months
    .map(
      (m, i) =>
        `<i class="hit" tabindex="0" data-i="${i}" aria-label="${esc(m.label)}: ${esc(formatNaira(m.paidKobo))}">` +
        `<em class="tip"><b>${esc(m.label)}</b>${m.paidKobo > 0 ? esc(formatNaira(m.paidKobo)) : "Nothing paid"}</em></i>`,
    )
    .join("");

  const peakLabel =
    `<p class="pv" style="left:${(((best + 0.5) * slot) / W * 100).toFixed(2)}%;bottom:${((peak / top) * 100).toFixed(2)}%">` +
    `${esc(compact(peak))}</p>`;

  // Hover a month and its own bar darkens: generated, because the bars and the
  // strips over them are siblings in two different layers.
  const lit = months
    .map((_, i) => `.plot:has(.hit[data-i="${i}"]:is(:hover,:focus)) [data-i="${i}"]{fill:var(--bar-hi)}`)
    .join("");

  return (
    `<style>${lit}</style>` +
    `<div class="plot">` +
    `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Money received by month">${grid}${rects}</svg>` +
    axis +
    peakLabel +
    `<div class="hits">${hits}</div>` +
    `</div>` +
    `<div class="xaxis">${months.map((m) => `<span>${esc(m.label)}</span>`).join("")}</div>`
  );
}

/**
 * Paid against outstanding, as one bar.
 *
 * A pie chart of two numbers is a worse bar chart. This is the single ratio
 * the page exists to show, and it reads in a glance because both figures are
 * written under it, each beside a swatch of its colour.
 */
function split(paidKobo: number, outstandingKobo: number): string {
  const total = paidKobo + outstandingKobo;
  if (total <= 0) return "";
  const pct = Math.round((paidKobo / total) * 100);
  return (
    `<div class="split" role="img" aria-label="${pct}% of everything invoiced has been paid">` +
    (pct > 0 ? `<span class="s-paid" style="flex:${pct}"></span>` : "") +
    (pct < 100 ? `<span class="s-owed" style="flex:${100 - pct}"></span>` : "") +
    `</div>` +
    `<div class="legend">` +
    `<p><i class="sw s-paid"></i>Paid <b>${esc(formatNaira(paidKobo))}</b><span>${pct}%</span></p>` +
    `<p><i class="sw s-owed"></i>Outstanding <b>${esc(formatNaira(outstandingKobo))}</b><span>${100 - pct}%</span></p>` +
    `</div>` +
    `<p class="pct">${pct}% of everything you have invoiced has been paid</p>`
  );
}

/** One row per document still owed, worst first. */
function owingRows(rows: SummaryData["owing"], today: Civil): string {
  if (!rows.length) return `<p class="none">Nobody owes you anything right now.</p>`;

  return `<ul class="list">${rows
    .map((d) => {
      const late = d.daysLate !== null && d.daysLate > 0;
      const when = d.dueDate
        ? late
          ? `${d.daysLate} day${d.daysLate === 1 ? "" : "s"} late`
          : `Due ${formatFriendly(d.dueDate, today)}`
        : "No due date";
      return (
        `<li>` +
        `<span class="av">${esc(initials(d.clientName))}</span>` +
        `<div class="mid"><p class="who">${esc(d.clientName)}</p>` +
        `<p class="sub">${d.ref ? esc(d.ref) : "&nbsp;"}</p></div>` +
        `<div class="end"><p class="amt">${esc(formatNaira(d.outstandingKobo))}</p>` +
        `<p class="st${late ? " late" : ""}">${esc(when)}</p></div></li>`
      );
    })
    .join("")}</ul>`;
}

/** Their best clients, each with a bar for their share of the best one. */
function clientRows(rows: SummaryData["clients"]): string {
  const top = Math.max(...rows.map((c) => c.paidKobo), 1);
  return `<ul class="list">${rows
    .map(
      (c) =>
        `<li><span class="av">${esc(initials(c.name))}</span>` +
        `<div class="mid"><p class="who">${esc(c.name)}</p>` +
        `<span class="meter"><span style="width:${Math.max(2, Math.round((c.paidKobo / top) * 100))}%"></span></span></div>` +
        `<div class="end"><p class="amt">${esc(formatNaira(c.paidKobo))}</p></div></li>`,
    )
    .join("")}</ul>`;
}

const WARN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z" fill="currentColor"/><path d="M8 6.2v3.6M8 11.6v.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const OK = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 8.3 7.1 10.4 11 6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function renderSummary(d: SummaryData, today: Civil): string {
  const invoiced = d.paidKobo + d.outstandingKobo;
  const year = d.months.reduce((n, m) => n + m.paidKobo, 0);
  const owingCount = d.owing.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="format-detection" content="telephone=no">
<title>Your Balans summary</title>
<style>
${fontFacesForPage(["sans", "display"])}
:root{--ink:#10231C;--bg:#F6F1E7;--card:#FFFFFF;--t1:#10231C;--t2:rgba(16,35,28,.62);--t3:rgba(16,35,28,.45);
--line:rgba(16,35,28,.08);--grid:rgba(16,35,28,.08);--soft:#F3EEE4;
--bar:${MOSS};--bar-hi:#2C6E47;--paid:${MOSS};--owed:${MARIGOLD};--late:${CLAY};--late-bg:rgba(194,89,63,.1);
--ok-bg:rgba(63,143,95,.12);--meter:rgba(63,143,95,.14);
--lift:0 0 0 1px rgba(16,35,28,.06),0 1px 2px rgba(16,35,28,.05),0 12px 32px -18px rgba(16,35,28,.2)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${FONT.sans};color:var(--t1);background:var(--bg);font-size:15px;
  line-height:1.45;-webkit-font-smoothing:antialiased;padding:0 0 calc(40px + env(safe-area-inset-bottom))}
.band{background:var(--ink);color:#F6F1E7;padding:26px 18px 96px}
.band .in,.wrap{max-width:640px;margin:0 auto}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(246,241,231,.55)}
h1{margin-top:6px;font-family:${FONT.display};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-.035em;overflow-wrap:anywhere}
.when{color:rgba(246,241,231,.6);font-size:13.5px;margin-top:4px}
.wrap{padding:0 12px;margin-top:-76px;display:grid;gap:12px}
.card{background:var(--card);border-radius:20px;padding:20px;box-shadow:var(--lift)}
h2{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:15px;font-weight:700;
  letter-spacing:-.01em;margin-bottom:14px}
h2 span{font-size:13px;font-weight:500;color:var(--t2)}
.lbl{font-size:13.5px;color:var(--t2)}
.hero .big{margin-top:4px;font-family:${FONT.display};font-size:44px;line-height:1.05;font-weight:800;letter-spacing:-.045em;overflow-wrap:anywhere}
.status{display:inline-flex;align-items:center;gap:6px;margin-top:10px;height:28px;padding:0 11px 0 8px;border-radius:999px;
  font-size:13px;font-weight:600}
.status svg{width:14px;height:14px;flex:none}
.status.late{background:var(--late-bg);color:var(--late)}
.status.ok{background:var(--ok-bg);color:var(--bar-hi)}
.status b{color:var(--t1);font-weight:700}
.split{display:flex;gap:2px;height:10px;border-radius:99px;overflow:hidden;margin-top:20px}
.split span{display:block;min-width:4px}
.s-paid{background:var(--paid)}.s-owed{background:var(--owed)}
.legend{margin-top:12px;display:grid;gap:6px}
.legend p{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--t2)}
.legend b{color:var(--t1);font-weight:600;font-variant-numeric:tabular-nums}
.legend span{margin-left:auto;color:var(--t3);font-variant-numeric:tabular-nums}
.sw{width:10px;height:10px;border-radius:3px;flex:none}
.pct{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tile{background:var(--card);border-radius:18px;padding:15px 16px;box-shadow:var(--lift);min-width:0}
.tile .k{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--t2)}
.tile .k svg{width:13px;height:13px;color:var(--late);flex:none}
.tile .v{margin-top:4px;font-family:${FONT.display};font-size:21px;font-weight:700;letter-spacing:-.03em;overflow-wrap:anywhere}
.plot{position:relative;margin-right:46px}
.bars{display:block;width:100%;height:auto;overflow:visible}
.bars line.g{stroke:var(--grid);stroke-width:1;vector-effect:non-scaling-stroke}
.bars line.base{stroke:var(--t3);stroke-width:1;vector-effect:non-scaling-stroke}
.bars rect,.bars path{fill:var(--bar);transition:fill .15s}
.yl{position:absolute;right:-46px;width:42px;transform:translateY(-50%);font-size:11px;color:var(--t3);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.pv{position:absolute;transform:translate(-50%,-4px);font-size:11.5px;font-weight:700;color:var(--t1);white-space:nowrap;pointer-events:none}
.hits{position:absolute;inset:0;display:flex}
.hit{flex:1;position:relative;outline:none;cursor:default;-webkit-tap-highlight-color:transparent}
.hit:hover,.hit:focus{background:linear-gradient(var(--grid),var(--grid))}
.tip{position:absolute;left:50%;top:-6px;transform:translate(-50%,-100%);display:none;flex-direction:column;
  padding:7px 10px;border-radius:10px;background:var(--ink);color:#F6F1E7;font-style:normal;font-size:12.5px;
  font-weight:600;white-space:nowrap;box-shadow:0 8px 20px rgba(16,35,28,.25);z-index:2;font-variant-numeric:tabular-nums}
.tip b{font-size:11px;font-weight:500;opacity:.7}
.hit:hover .tip,.hit:focus .tip{display:flex}
.hit:first-child .tip{left:0;transform:translate(0,-100%)}
.hit:last-child .tip{left:auto;right:0;transform:translate(0,-100%)}
.xaxis{display:flex;margin:8px 46px 0 0}
.xaxis span{flex:1;text-align:center;font-size:11px;color:var(--t3)}
.list{list-style:none}
.list li{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0;padding-top:2px}
.av{width:36px;height:36px;border-radius:50%;flex:none;display:grid;place-items:center;background:var(--soft);
  font-size:12.5px;font-weight:700;color:var(--t2)}
.mid{min-width:0;flex:1}
.who{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{font-size:12.5px;color:var(--t3)}
.end{text-align:right;flex:none;min-width:6.6em}
.amt{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.st{font-size:12.5px;color:var(--t3)}
.st.late{color:var(--late);font-weight:600}
.meter{display:block;margin-top:6px;height:6px;border-radius:99px;background:var(--meter);overflow:hidden}
.meter span{display:block;height:100%;border-radius:99px;background:var(--bar)}
.none{color:var(--t2);font-size:14px}
footer{margin-top:8px;text-align:center;font-size:12.5px;color:var(--t3)}
@media (min-width:600px){
  .band{padding:34px 24px 104px}
  h1{font-size:30px}
  .wrap{padding:0 20px}
  .card{padding:24px}
  .tiles{grid-template-columns:repeat(4,1fr)}
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0B1612;--card:#13221C;--t1:#EDE7DA;--t2:rgba(237,231,218,.66);--t3:rgba(237,231,218,.45);
    --line:rgba(237,231,218,.08);--grid:rgba(237,231,218,.09);--soft:#1B2E26;--bar:#5DB282;--bar-hi:#82CDA1;--paid:#5DB282;
    --late:#E58A6F;--late-bg:rgba(229,138,111,.14);--ok-bg:rgba(93,178,130,.16);--meter:rgba(93,178,130,.16);
    --lift:0 0 0 1px rgba(237,231,218,.06)}
  .band{background:#07100D}
  .tip{background:#EDE7DA;color:#10231C}
}
</style></head>
<body>
<header class="band"><div class="in">
  <p class="eyebrow">Summary</p>
  <h1>${esc(d.businessName)}</h1>
  <p class="when">Everything so far · ${esc(formatFriendly(today, today))}</p>
</div></header>

<main class="wrap">
<section class="card hero">
  <p class="lbl">Owed to you${owingCount ? ` · ${owingCount} ${owingCount === 1 ? "invoice" : "invoices"}` : ""}</p>
  <p class="big">${esc(formatNaira(d.outstandingKobo))}</p>
  ${
    d.overdueKobo > 0
      ? `<p class="status late">${WARN}<b>${esc(formatNaira(d.overdueKobo))}</b> overdue</p>`
      : `<p class="status ok">${OK}Nothing overdue</p>`
  }
  ${invoiced > 0 ? split(d.paidKobo, d.outstandingKobo) : ""}
</section>

<section class="tiles" aria-label="Where you stand">
  ${tile("Paid to you", formatNaira(d.paidKobo))}
  ${tile(`${d.overdueKobo > 0 ? WARN : ""}Overdue`, formatNaira(d.overdueKobo))}
  ${tile("Invoices sent", String(d.invoicesSent))}
  ${tile("Invoiced in total", formatNaira(invoiced))}
</section>

<section class="card">
  <h2>Money in, by month${year > 0 ? `<span>${esc(formatNaira(year))} in ${d.months.length} month${d.months.length === 1 ? "" : "s"}</span>` : ""}</h2>
  ${bars(d.months)}
</section>

<section class="card">
  <h2>Who owes you${owingCount ? `<span>${owingCount}</span>` : ""}</h2>
  ${owingRows(d.owing, today)}
</section>

${
  d.clients.length
    ? `<section class="card"><h2>Your best clients<span>By what they have paid</span></h2>${clientRows(d.clients)}</section>`
    : ""
}

<footer>This page is private to you. The link stops working after a day.</footer>
</main>
</body></html>`;
}
