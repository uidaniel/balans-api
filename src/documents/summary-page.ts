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

const INK = "#10231C";
const MARIGOLD = "#F5B82E";
const MOSS = "#3F8F5F";
const CLAY = "#C2593F";

/** A number big enough to read at arm's length, and its label above it. */
const stat = (label: string, value: string, tone = ""): string =>
  `<div class="stat${tone}"><p class="k">${esc(label)}</p><p class="v">${esc(value)}</p></div>`;

/**
 * Money in by month, as bars.
 *
 * Drawn rather than plotted. A chart library is tens of kilobytes over a
 * connection that may not finish, to draw twelve rectangles — and a page that
 * half-loads on a phone is worse than one that is plainer than it could have
 * been.
 *
 * Heights are a share of the best month, so the shape is the comparison. An
 * empty history says so in words rather than drawing twelve zero-height bars,
 * which read as a broken chart rather than as no history.
 */
function bars(months: SummaryData["months"]): string {
  if (!months.some((m) => m.paidKobo > 0)) {
    return `<p class="none">No payments yet. This fills in as clients pay you.</p>`;
  }

  const peak = Math.max(...months.map((m) => m.paidKobo), 1);
  const w = 100 / months.length;

  return (
    `<svg class="bars" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" ` +
    `aria-label="Money received by month">` +
    months
      .map((m, i) => {
        /*
         * A month with nothing in it draws no bar at all, and keeps its label
         * on the axis below. The gap is the point: dropping the month
         * entirely would close it up and make a quiet quarter look busy, and
         * a zero-height rectangle is an invisible element pretending to be
         * data.
         *
         * Everything else gets a floor, so a month with a little money is
         * visibly different from a month with none.
         */
        if (m.paidKobo <= 0) return "";
        const h = Math.max(0.6, (m.paidKobo / peak) * 30);
        const x = i * w + w * 0.18;
        return (
          `<rect x="${x.toFixed(2)}" y="${(30 - h).toFixed(2)}" ` +
          `width="${(w * 0.64).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6" fill="${MARIGOLD}"/>`
        );
      })
      .join("") +
    `</svg>` +
    `<div class="xaxis">${months.map((m) => `<span>${esc(m.label)}</span>`).join("")}</div>`
  );
}

/**
 * Paid against outstanding, as one bar.
 *
 * A pie chart of two numbers is a worse bar chart. This is the single ratio
 * the page exists to show, and it reads in a glance without a legend because
 * both figures are written above it in the same two colours.
 */
function split(paidKobo: number, outstandingKobo: number): string {
  const total = paidKobo + outstandingKobo;
  if (total <= 0) return "";
  const pct = Math.round((paidKobo / total) * 100);
  return (
    `<div class="split" role="img" aria-label="${pct}% of everything invoiced has been paid">` +
    `<span style="width:${pct}%;background:${MOSS}"></span>` +
    `<span style="width:${100 - pct}%;background:${MARIGOLD}"></span>` +
    `</div><p class="pct">${pct}% of everything you have invoiced has been paid</p>`
  );
}

/** One row per document still owed, worst first. */
function owingRows(rows: SummaryData["owing"], today: Civil): string {
  if (!rows.length) return `<p class="none">Nobody owes you anything right now.</p>`;

  return rows
    .map((d) => {
      const late = d.daysLate !== null && d.daysLate > 0;
      const when = d.dueDate
        ? late
          ? `${d.daysLate} day${d.daysLate === 1 ? "" : "s"} late`
          : `due ${formatFriendly(d.dueDate, today)}`
        : "no date";
      return (
        `<li${late ? ' class="late"' : ""}>` +
        `<div><p class="who">${esc(d.clientName)}</p>` +
        `<p class="sub">${esc(when)}${d.ref ? ` · ${esc(d.ref)}` : ""}</p></div>` +
        `<p class="amt">${esc(formatNaira(d.outstandingKobo))}</p></li>`
      );
    })
    .join("");
}

export function renderSummary(d: SummaryData, today: Civil): string {
  const invoiced = d.paidKobo + d.outstandingKobo;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Your Balans summary</title>
<style>
${fontFacesForPage(["sans", "display"])}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:${FONT.sans};color:${INK};background:#F6F1E7;
  line-height:1.45;-webkit-font-smoothing:antialiased;
  padding:24px 16px calc(40px + env(safe-area-inset-bottom));
}
.wrap{max-width:560px;margin:0 auto}
h1{font-family:${FONT.display};font-size:1.45rem;font-weight:800;letter-spacing:-.01em}
.when{color:rgba(16,35,28,.55);font-size:.85rem;margin-top:2px}
section{background:#fff;border-radius:18px;padding:18px;margin-top:14px}
h2{font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
   color:rgba(16,35,28,.5);margin-bottom:12px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{background:#F6F1E7;border-radius:14px;padding:12px 14px}
.stat.wide{grid-column:1 / -1}
.stat .k{font-size:.76rem;color:rgba(16,35,28,.55)}
.stat .v{font-family:${FONT.display};font-size:1.3rem;font-weight:800;letter-spacing:-.01em;margin-top:2px}
.stat.owed .v{color:${MARIGOLD}}
.stat.late .v{color:${CLAY}}
.split{display:flex;height:12px;border-radius:99px;overflow:hidden;margin-bottom:8px}
.pct{font-size:.85rem;color:rgba(16,35,28,.6)}
.bars{width:100%;height:110px;display:block}
.xaxis{display:flex;margin-top:6px}
.xaxis span{flex:1;text-align:center;font-size:.62rem;color:rgba(16,35,28,.45)}
ul{list-style:none}
li{display:flex;align-items:center;justify-content:space-between;gap:12px;
   padding:11px 0;border-top:1px solid rgba(16,35,28,.08)}
li:first-child{border-top:0}
.who{font-weight:600}
.sub{font-size:.76rem;color:rgba(16,35,28,.5)}
li.late .sub{color:${CLAY}}
.amt{font-family:${FONT.display};font-weight:700;white-space:nowrap}
.none{color:rgba(16,35,28,.5);font-size:.9rem}
footer{margin-top:20px;text-align:center;font-size:.72rem;color:rgba(16,35,28,.45)}
@media (prefers-color-scheme:dark){
  body{background:#0E1A16;color:#EDE7DA}
  section{background:#16241F}
  .stat{background:#0E1A16}
  .stat .k,.when,.pct,.sub,.none,footer{color:rgba(237,231,218,.55)}
  h2{color:rgba(237,231,218,.45)}
  li{border-top-color:rgba(237,231,218,.1)}
  .xaxis span{color:rgba(237,231,218,.4)}
}
</style></head>
<body><div class="wrap">

<h1>${esc(d.businessName)}</h1>
<p class="when">Everything so far · ${esc(formatFriendly(today, today))}</p>

<section>
  <h2>Where you stand</h2>
  <div class="stats">
    ${stat("Owed to you", formatNaira(d.outstandingKobo), " owed")}
    ${stat("Overdue", formatNaira(d.overdueKobo), " late")}
    ${stat("Paid to you", formatNaira(d.paidKobo))}
    ${stat("Invoices sent", String(d.invoicesSent))}
    ${invoiced > 0 ? stat("Invoiced in total", formatNaira(invoiced), " wide") : ""}
  </div>
</section>

${
  invoiced > 0
    ? `<section><h2>Paid against outstanding</h2>${split(d.paidKobo, d.outstandingKobo)}</section>`
    : ""
}

<section>
  <h2>Money in, by month</h2>
  ${bars(d.months)}
</section>

<section>
  <h2>Who owes you</h2>
  <ul>${owingRows(d.owing, today)}</ul>
</section>

${
  d.clients.length
    ? `<section><h2>Your best clients</h2><ul>${d.clients
        .map(
          (c) =>
            `<li><div><p class="who">${esc(c.name)}</p></div>` +
            `<p class="amt">${esc(formatNaira(c.paidKobo))}</p></li>`,
        )
        .join("")}</ul></section>`
    : ""
}

<footer>This page is private to you. The link stops working after a day.</footer>
</div></body></html>`;
}
