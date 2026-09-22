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
import { outstandingKobo, payable, payableLabel, payableNowKobo, type PublicDocument } from "./public.ts";
import { logoAvailable, logoSvg, monnifyLogo } from "../brand/logo.ts";

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
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.03em;
font-size:20px;color:var(--ink)}
.brand svg{height:36px;width:auto;display:block}
.dot{width:14px;height:14px;border-radius:50%;background:var(--marigold);flex:none}
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
.pay{padding:26px 16px 30px}
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
.parts{padding:16px 28px 0}
.part{display:flex;justify-content:space-between;align-items:center;
padding:11px 0;border-bottom:1px solid #f0ece3;font-size:14.5px}
.part:last-child{border-bottom:0}
.part .who{color:#4a5d54}
.part .amt{font-weight:650}
.part.done .who,.part.done .amt{color:var(--moss)}
.part .tag{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;
color:#8a9a92;margin-left:8px;font-weight:600}
.trust{margin:24px 28px 0;padding:18px 20px;background:var(--cream);
border:1px solid var(--sand);border-radius:14px}
.tline{display:flex;align-items:center;justify-content:center;gap:9px;
font-size:13.5px;color:#4a5d54;font-weight:550;flex-wrap:wrap}
.tline .shield{width:16px;height:16px;color:var(--moss);flex:none}
.tline .mlogo{height:22px;width:auto;display:block}
.tsmall{margin-top:11px;text-align:center;font-size:12.5px;line-height:1.65;color:#7d8d85}
.tsmall b{color:#5c6f66;font-weight:600}
.files{padding:22px 28px 26px;text-align:center;font-size:13.5px}
.files a{color:#5c6f66;text-decoration:underline;text-underline-offset:3px}
.foot{max-width:640px;margin:18px auto 0;text-align:center;font-size:13px;color:#7d8d85}
.foot a{color:#7d8d85}
/* The transfer step is the one thing on this page that is an action rather
   than a document, so it sits on ink and everything above it stays paper. */
.tcard{background:var(--ink);border-radius:18px;padding:26px 22px 22px;text-align:center}
.teyebrow{font-size:11.5px;letter-spacing:.11em;text-transform:uppercase;
font-weight:650;color:#7f918a}
.tamt{font-size:17px;font-weight:700;letter-spacing:-.02em}
.tbox{margin-top:18px;background:#18302a;border-radius:13px;overflow:hidden;text-align:left}
.trow{display:flex;align-items:center;justify-content:space-between;gap:14px;
padding:13px 16px;border-top:1px solid #254236}
.trow:first-child{border-top:0}
.trow.wide{display:block}
/* The account number reads as one of the four details, on its line, in the
   same shape as the rest. It was on a line of its own at 26px, which made it
   look like a different kind of thing from the bank and the amount beside it. */
.tk{color:#869790;font-size:13px;flex:none}
.tv{font-weight:650;text-align:right;color:var(--cream);min-width:0;font-size:14.5px}
.trow.wide .tv{text-align:left;margin-top:5px}
.tv .acct{font-variant-numeric:tabular-nums;letter-spacing:.04em;
font-size:20px;font-weight:700;color:var(--cream);line-height:1.2}
button.tcopy{display:block;width:100%;margin-top:18px;padding:15px;border:0;
border-radius:13px;background:var(--marigold);color:var(--ink);font-size:16px;
font-weight:700;letter-spacing:-.01em;cursor:pointer;font-family:inherit}
button.tcopy:hover{background:var(--marigold-deep)}
button.tcopy.done{background:#2f6b47;color:#e8f5ed}
.tfine{margin:16px 4px 0;font-size:13.5px;line-height:1.65;color:#6b7d74;text-align:center}
.tfine strong{color:var(--ink);font-weight:650}
.twait{margin-top:16px;font-size:13px;color:#8fa199;text-align:center;line-height:1.7}
.twait .dot{display:inline-block;vertical-align:baseline;width:7px;height:7px;
border-radius:50%;background:var(--marigold);margin-right:8px;animation:pulse 1.8s ease-in-out infinite}
.twait .tleft{color:#6d807a}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.twait .dot{animation:none;opacity:.8}}
.tussd{margin-top:12px;text-align:center;font-size:13.5px;color:#6b7d74}
@media(max-width:520px){
  .tcard{padding:22px 16px 18px}
  .trow{padding:12px 13px}
  .tv .acct{font-size:18px;letter-spacing:.03em}
}
@media(max-width:520px){
  body{padding:14px 10px 48px}
  .sheet{border-radius:16px}
  .top{padding:22px 18px 0}
  h1{font-size:25px}
  th{padding:0 18px 10px}
  td{padding:12px 18px}
  .totals{padding:16px 18px 0}
  .pay,.banner{padding:20px 10px 24px;margin-left:8px;margin-right:8px}
  .trust{margin-left:18px;margin-right:18px;padding:14px 14px}
  .note{margin-left:18px;margin-right:18px}
}
`;


/**
 * Enhancements for the transfer panel: copy, a countdown, and polling.
 *
 * Deliberately additive. The account details are already in the HTML, so a
 * browser that runs none of this still shows a payable invoice — the client
 * reads the number, sends the money, and refreshes. Everything here only
 * shortens that loop.
 *
 * The poll asks our own server, which answers from our database. It never
 * asks the processor and never decides anything: a payment becomes paid on a
 * verified webhook, and this is just how the page finds out.
 */
const TRANSFER_JS = `
(function () {
  var box = document.querySelector('.transfer');
  if (!box) return;

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button.copy');
    if (!b) return;
    var text = b.getAttribute('data-copy') || '';
    var done = function () {
      var was = b.textContent;
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(function () { b.textContent = was; b.classList.remove('done'); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch (err) {}
      document.body.removeChild(t);
    }
  });

  var left = box.querySelector('.tleft');
  var ends = Date.now() + Number(box.getAttribute('data-expires') || 0);
  function tick() {
    var ms = ends - Date.now();
    if (!left) return;
    if (ms <= 0) {
      left.hidden = false;
      left.textContent = ' \u2014 these details have expired, refresh for new ones';
      return;
    }
    var mins = Math.floor(ms / 60000), secs = Math.floor((ms % 60000) / 1000);
    left.hidden = false;
    left.textContent = ' \u2014 ' + mins + ':' + (secs < 10 ? '0' : '') + secs + ' left';
    setTimeout(tick, 1000);
  }
  tick();

  // Backs off as it goes, so a page left open all afternoon is not a
  // request every three seconds all afternoon.
  var token = box.getAttribute('data-token');
  var wait = 3000;
  function poll() {
    fetch('/i/' + token + '/status', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.paid) { location.reload(); return; }
        wait = Math.min(wait * 1.25, 20000);
        setTimeout(poll, wait);
      })
      .catch(function () { setTimeout(poll, 10000); });
  }
  setTimeout(poll, wait);
})();
`;

const LABEL: Record<PublicDocument["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Payment request",
  sample: "Sample",
};

/**
 * The one-time account a client transfers into.
 *
 * Structurally typed rather than imported from the store, because everything
 * in this file is pure and tested by calling it with a fixture.
 */
export type TransferPanel = {
  bankName: string;
  accountNumber: string;
  accountName: string;
  amountKobo: number;
  ussd: string | null;
  /** Milliseconds from render until the account stops accepting the transfer. */
  expiresInMs: number;
};

export function renderDocument(
  doc: PublicDocument,
  today: Civil,
  opts: { token: string; error?: string; transfer?: TransferPanel | null } = { token: "" },
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
<!-- Without this iOS reads a ten-digit account number as a phone number and
     renders it as a blue call link. Tapping the thing we are asking somebody
     to copy would offer to dial it. -->
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${label} ${doc.number} from ${esc(doc.businessName)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="${label} for ${esc(formatNaira(doc.totalKobo))} from ${esc(doc.businessName)}.">
<style>${CSS}</style>
</head><body>
<div class="sheet">
  <div class="top">
    <div class="brand">${
      // The real logo where we have it; the wordmark in text if the asset is
      // missing, because a payment page must render either way.
      logoAvailable() ? logoSvg("36px") : `<span class="dot"></span>balans`
    }</div>
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

  ${partsBlock(doc)}
  ${doc.notes ? `<div class="note">${esc(doc.notes)}</div>` : ""}
  ${payBlock(doc, can, payableNowKobo(doc), opts, payableLabel(doc))}
  ${trustBlock(doc)}
  <div class="files">
    ${
      // F8: a payment request is "a lightweight payable with no PDF". There is
      // nothing itemised to render, and offering one implies there is.
      doc.type === "payment_request"
        ? ""
        : `<a href="/i/${esc(opts.token)}/pdf">Download ${label.toLowerCase()} (PDF)</a>`
    }
    ${
      doc.amountPaidKobo > 0
        ? `${doc.type === "payment_request" ? "" : " &middot; "}<a href="/i/${esc(opts.token)}/receipt">Receipt</a>`
        : ""
    }
  </div>
</div>
<p class="foot">Invoiced with balans &middot; <a href="https://balans.ng">balans.ng</a></p>
${opts.transfer ? `<script>${TRANSFER_JS}</script>` : ""}
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

/**
 * The parts of a split invoice (F7).
 *
 * Shown even once they are paid, because the point of a deposit is that the
 * client can see the shape of the whole arrangement and what is left of it.
 */
function partsBlock(doc: PublicDocument): string {
  if (!doc.parts.length) return "";

  const rows = doc.parts
    .map((p) => {
      const done = p.status === "paid";
      const tag = done ? "Paid" : p.status === "payable" ? "Due now" : "Later";
      return `<div class="part${done ? " done" : ""}">
        <span class="who">${esc(p.label)}<span class="tag">${tag}</span></span>
        <span class="amt">${formatNaira(p.amountKobo)}</span>
      </div>`;
    })
    .join("");

  return `<div class="parts">${rows}</div>`;
}

function payBlock(
  doc: PublicDocument,
  can: ReturnType<typeof payable>,
  amount: number,
  opts: { token: string; error?: string; transfer?: TransferPanel | null },
  partLabel: string | null,
): string {
  if (can.ok) {
    // Details already issued: show them instead of asking again. A client who
    // has gone to their banking app and come back must meet the same account.
    if (opts.transfer) return transferBlock(doc, opts.transfer, opts.token);

    // A plain form post, so the button works with no JavaScript at all.
    return `<div class="pay">
    ${opts.error ? `<p class="banner cancelled" style="margin:0 0 14px">${esc(opts.error)}</p>` : ""}
    <form method="post" action="/i/${esc(opts.token)}/pay">
      <button class="pay-btn" type="submit">Pay ${formatNaira(amount)}${
        partLabel ? ` &middot; ${esc(partLabel)}` : ""
      }</button>
    </form>
    <p class="secure">Pay by bank transfer to ${esc(doc.businessName)}. Takes about a minute.</p>
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


/**
 * The account to transfer into.
 *
 * Everything needed to complete the payment is rendered here by the server,
 * so the panel works with JavaScript switched off: the client can read the
 * account, send the money, and refresh to see it land. The countdown, the copy
 * button and the polling are enhancements on top, never the mechanism.
 *
 * Two things on this panel are load-bearing and easy to get wrong.
 *
 * The account name is Monnify's, not the freelancer's, because that is whose
 * collection account it is. A client who reads an unfamiliar name on a payment
 * screen is right to hesitate, so it is labelled and explained rather than
 * quietly displayed and hoped over.
 *
 * And the amount has to be exact. These accounts are matched on the amount as
 * well as the number, so "about right" does not settle; the figure is given
 * once, in full, with nothing else competing for the same attention.
 */
function transferBlock(doc: PublicDocument, t: TransferPanel, token: string): string {
  const amount = formatNaira(t.amountKobo);

  const row = (k: string, v: string, cls = "") =>
    `<div class="trow${cls ? ` ${cls}` : ""}"><span class="tk">${k}</span><span class="tv">${v}</span></div>`;

  return `<div class="pay transfer" data-token="${esc(token)}" data-expires="${t.expiresInMs}">
  <div class="tcard">
    <p class="teyebrow">Pay by bank transfer</p>

    <div class="tbox">
      ${row("Bank", esc(t.bankName))}
      ${row("Account number", `<span class="acct">${esc(t.accountNumber)}</span>`)}
      ${t.accountName ? row("Account name", esc(t.accountName)) : ""}
      ${row("Amount", `<span class="tamt">${amount}</span>`)}
    </div>

    <button class="tcopy copy" type="button" data-copy="${esc(t.accountNumber)}">Copy account number</button>

    <p class="twait" role="status">
      <span class="dot"></span>Waiting for your transfer<span class="tleft" hidden></span>
    </p>
  </div>

  <p class="tfine">
    Send <strong>exactly ${amount}</strong>. This account is for this ${LABEL[doc.type].toLowerCase()} alone${
      t.accountName ? `, which is why it reads <strong>${esc(t.accountName)}</strong>` : ""
    } &mdash; no reference needed.
  </p>

  ${t.ussd ? `<p class="tfine">On your phone: <strong>${esc(t.ussd)}</strong></p>` : ""}

  <noscript><p class="tfine">Refresh this page after sending, to see it confirmed.</p></noscript>
</div>`;
}


/**
 * Who is handling the money, and who is not.
 *
 * The page asks a stranger to transfer real money to an account name they do
 * not recognise. Everything that makes that reasonable belongs in one place,
 * stated plainly rather than implied: the processor's own mark, the fact that
 * we are not a bank and hold nothing, and where the money actually lands.
 *
 * These are also the two lines section 12 requires on every surface a client
 * sees. They were on the PDF and missing here, which was the wrong way round
 * — this is the page where somebody decides whether to part with the money.
 */
function trustBlock(doc: PublicDocument): string {
  const mark = monnifyLogo();

  return `<div class="trust">
    <div class="tline">
      <svg class="shield" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.75 2.75 3.6v3.9c0 3.1 2.2 5.6 5.25 6.75 3.05-1.15 5.25-3.65 5.25-6.75V3.6L8 1.75Z"
              stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="m5.6 8 1.7 1.7 3.1-3.3" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Payments processed by</span>
      ${mark ? `<img class="mlogo" src="${mark}" alt="Monnify" width="88" height="20">` : `<b>Monnify</b>`}
    </div>
    <p class="tsmall">
      Balans is not a bank and does not hold your money. This payment settles
      directly to the bank account of <b>${esc(doc.businessName)}</b>.
    </p>
  </div>`;
}

/** A 404 that does not confirm whether the token was ever real. */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>Not found</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body>
<div class="sheet"><div class="top" style="padding-bottom:28px">
  <div class="brand">${logoAvailable() ? logoSvg("36px") : `<span class="dot"></span>balans`}</div>
  <h1 style="margin-top:22px">Nothing here</h1>
  <p class="from">This link has expired, or it was never quite right. Ask whoever sent it for a new one.</p>
</div></div>
<p class="foot"><a href="https://balans.ng">balans.ng</a></p>
</body></html>`;
}

const compare = (a: Civil, b: Civil): number =>
  Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
