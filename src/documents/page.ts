/**
 * The public document page (PRD F9).
 *
 * Plain server-rendered HTML with the styles inline. No build step, no
 * framework, no JavaScript needed to read an invoice or press Pay — this page
 * is opened by a stranger on a Nigerian phone, quite possibly on a slow
 * connection, and it has one job: show what is owed and take the money.
 *
 * Everything interpolated goes through `esc`. A client's name and a line
 * description are user input, and this is the one place in the system where
 * user input is rendered into markup a third party sees.
 */

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { outstandingKobo, payable, type PublicDocument } from "./public.ts";

/** HTML-escapes text. Also escapes quotes, for anything inside an attribute. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Brand tokens, copied from the web app's globals.css. Duplicated on purpose:
   this page must render from a cold server with no shared stylesheet. */
const CSS = `
:root{--marigold:#f5b82e;--marigold-deep:#d99a12;--ink:#10231c;--ink-2:#173128;
--cream:#f6f1e7;--sand:#e9e1d0;--sand-2:#ddd3bf;--moss:#3f8f5f;--clay:#c2462e}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased;line-height:1.5;padding:24px 16px 64px}
.sheet{max-width:640px;margin:0 auto;background:#fff;border:1px solid var(--sand-2);
border-radius:20px;overflow:hidden}
.top{padding:28px 28px 0}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.03em;
font-size:15px;color:var(--ink)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--marigold);flex:none}
.kind{margin-top:22px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;
color:#6b7d74;font-weight:600}
h1{font-size:30px;letter-spacing:-.045em;font-weight:700;margin-top:4px;line-height:1.15}
.from{margin-top:14px;font-size:15px;color:#4a5d54}
.from b{color:var(--ink);font-weight:600}
.pill{display:inline-block;margin-top:16px;padding:5px 12px;border-radius:999px;
font-size:12.5px;font-weight:650;letter-spacing:.01em}
.pill.due{background:var(--sand);color:var(--ink-2)}
.pill.paid{background:#e4f2e9;color:#256b41}
.pill.overdue{background:#fbe6e1;color:var(--clay)}
.pill.cancelled{background:#eceae6;color:#6b7d74}
table{width:100%;border-collapse:collapse;margin-top:26px}
th{text-align:left;font-size:12px;letter-spacing:.07em;text-transform:uppercase;
color:#6b7d74;font-weight:600;padding:0 28px 10px;border-bottom:1px solid var(--sand)}
th.r,td.r{text-align:right}
td{padding:14px 28px;border-bottom:1px solid #f0ece3;font-size:15px;vertical-align:top}
td .qty{display:block;font-size:13px;color:#6b7d74;margin-top:2px}
.totals{padding:18px 28px 0}
.row{display:flex;justify-content:space-between;font-size:15px;color:#4a5d54;padding:5px 0}
.row.grand{margin-top:10px;padding-top:16px;border-top:2px solid var(--ink);
font-size:20px;color:var(--ink);font-weight:700;letter-spacing:-.02em}
.row.paidoff{color:var(--moss)}
.note{margin:20px 28px 0;padding:14px 16px;background:var(--cream);
border-radius:12px;font-size:14px;color:#4a5d54;white-space:pre-wrap}
.pay{padding:26px 28px 30px}
button.pay-btn,a.pay-btn{display:block;width:100%;padding:16px;border:0;border-radius:14px;
background:var(--marigold);color:var(--ink);font-size:17px;font-weight:700;
letter-spacing:-.01em;cursor:pointer;text-align:center;text-decoration:none;
font-family:inherit}
button.pay-btn:hover,a.pay-btn:hover{background:var(--marigold-deep)}
button.pay-btn:disabled{opacity:.5;cursor:default}
.secure{margin-top:12px;text-align:center;font-size:12.5px;color:#6b7d74}
.banner{margin:26px 28px 30px;padding:16px;border-radius:14px;font-size:15px;text-align:center}
.banner.paid{background:#e4f2e9;color:#256b41;font-weight:600}
.banner.cancelled{background:#eceae6;color:#57665e}
.banner.quote{background:var(--cream);color:#4a5d54}
.files{padding:0 28px 26px;text-align:center;font-size:13.5px}
.files a{color:#5c6f66;text-decoration:underline;text-underline-offset:3px}
.foot{max-width:640px;margin:18px auto 0;text-align:center;font-size:13px;color:#7d8d85}
.foot a{color:#7d8d85}
@media(max-width:520px){
  body{padding:14px 10px 48px}
  .sheet{border-radius:16px}
  .top{padding:22px 18px 0}
  h1{font-size:25px}
  th{padding:0 18px 10px}
  td{padding:12px 18px}
  .totals{padding:16px 18px 0}
  .pay,.banner{padding:20px 18px 24px;margin-left:18px;margin-right:18px}
  .note{margin-left:18px;margin-right:18px}
}
`;

const LABEL: Record<PublicDocument["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Payment request",
  sample: "Sample",
};

export function renderDocument(
  doc: PublicDocument,
  today: Civil,
  opts: { token: string; error?: string } = { token: "" },
): string {
  const label = LABEL[doc.type];
  const outstanding = outstandingKobo(doc);
  const can = payable(doc);
  const overdue =
    doc.dueDate !== null &&
    doc.type === "invoice" &&
    outstanding > 0 &&
    compare(doc.dueDate, today) < 0;

  const rows = doc.lines
    .map(
      (l) => `<tr><td>${esc(l.description)}${
        l.qty === 1 ? "" : `<span class="qty">${l.qty} &times; ${formatNaira(l.unitAmountKobo)}</span>`
      }</td><td class="r">${formatNaira(l.amountKobo)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${label} ${doc.number} from ${esc(doc.businessName)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="${label} for ${esc(formatNaira(doc.totalKobo))} from ${esc(doc.businessName)}.">
<style>${CSS}</style>
</head><body>
<div class="sheet">
  <div class="top">
    <div class="brand"><span class="dot"></span>balans</div>
    <div class="kind">${label} ${doc.number}</div>
    <h1>${formatNaira(doc.totalKobo)}</h1>
    <div class="from">From <b>${esc(doc.businessName)}</b> to ${esc(doc.clientName)}</div>
    ${statusPill(doc, today, overdue)}
  </div>

  <table>
    <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    ${
      doc.vatKobo > 0
        ? `<div class="row"><span>Subtotal</span><span>${formatNaira(doc.subtotalKobo)}</span></div>
           <div class="row"><span>VAT</span><span>${formatNaira(doc.vatKobo)}</span></div>`
        : ""
    }
    ${
      doc.amountPaidKobo > 0
        ? `<div class="row"><span>Total</span><span>${formatNaira(doc.totalKobo)}</span></div>
           <div class="row paidoff"><span>Paid</span><span>&minus;${formatNaira(doc.amountPaidKobo)}</span></div>
           <div class="row grand"><span>Still owed</span><span>${formatNaira(outstanding)}</span></div>`
        : `<div class="row grand"><span>Total</span><span>${formatNaira(doc.totalKobo)}</span></div>`
    }
  </div>

  ${doc.notes ? `<div class="note">${esc(doc.notes)}</div>` : ""}
  ${payBlock(doc, can, outstanding, opts)}
  <div class="files">
    <a href="/i/${esc(opts.token)}/pdf">Download ${label.toLowerCase()} (PDF)</a>
    ${
      doc.amountPaidKobo > 0
        ? ` &middot; <a href="/i/${esc(opts.token)}/receipt">Receipt</a>`
        : ""
    }
  </div>
</div>
<p class="foot">Invoiced with balans &middot; <a href="https://balans.ng">balans.ng</a></p>
</body></html>`;
}

function statusPill(doc: PublicDocument, today: Civil, overdue: boolean): string {
  if (doc.status === "cancelled") return `<span class="pill cancelled">Cancelled</span>`;
  if (doc.status === "paid" || outstandingKobo(doc) === 0) {
    return `<span class="pill paid">Paid in full &mdash; thank you</span>`;
  }
  if (!doc.dueDate) return "";

  const when = formatFriendly(doc.dueDate, today);
  if (doc.type === "quote") return `<span class="pill due">Valid until ${when}</span>`;
  if (overdue) return `<span class="pill overdue">Was due ${when}</span>`;
  return `<span class="pill due">Due ${when}</span>`;
}

function payBlock(
  doc: PublicDocument,
  can: ReturnType<typeof payable>,
  outstanding: number,
  opts: { token: string; error?: string },
): string {
  if (can.ok) {
    // A plain form post, so the button works with no JavaScript at all.
    return `<div class="pay">
    ${opts.error ? `<p class="banner cancelled" style="margin:0 0 14px">${esc(opts.error)}</p>` : ""}
    <form method="post" action="/i/${esc(opts.token)}/pay">
      <button class="pay-btn" type="submit">Pay ${formatNaira(outstanding)}</button>
    </form>
    <p class="secure">Paid securely to ${esc(doc.businessName)}. Card, transfer or USSD.</p>
  </div>`;
  }

  switch (can.why) {
    case "paid":
      return `<div class="banner paid">Paid in full. Nothing more to do.</div>`;
    case "cancelled":
      return `<div class="banner cancelled">This ${LABEL[doc.type].toLowerCase()} was cancelled and cannot be paid.</div>`;
    case "quote":
      return `<div class="banner quote">This is a quote, not an invoice. Reply to ${esc(doc.businessName)} to accept it.</div>`;
    case "sample":
      return `<div class="banner quote">A sample, to show what a Balans invoice looks like.</div>`;
    default:
      // No settlement account: say something true without explaining our
      // plumbing to the client.
      return `<div class="banner cancelled">Online payment is not set up for this ${LABEL[doc.type].toLowerCase()} yet. Contact ${esc(doc.businessName)} to arrange payment.</div>`;
  }
}

/** A 404 that does not confirm whether the token was ever real. */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body>
<div class="sheet"><div class="top" style="padding-bottom:28px">
  <div class="brand"><span class="dot"></span>balans</div>
  <h1 style="margin-top:22px">Nothing here</h1>
  <p class="from">This link has expired, or it was never quite right. Ask whoever sent it for a new one.</p>
</div></div>
<p class="foot"><a href="https://balans.ng">balans.ng</a></p>
</body></html>`;
}

const compare = (a: Civil, b: Civil): number =>
  Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
