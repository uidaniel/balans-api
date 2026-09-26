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
import { formatMoney } from "../../core/currency.ts";
import { agreedTotalMinor } from "../../core/exchange.ts";
import { outstandingKobo, payable, payableLabel, payableNowKobo, type PublicDocument } from "./public.ts";
import { logoAvailable, logoSvg, markSvg, processorLogo, type Processor } from "../brand/logo.ts";
import { FONT, fontFacesForPage } from "../pdf/fonts.ts";

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
   this page must render from a cold server with no shared stylesheet. The
   faces are the site's too — Instrument Sans for reading, Geist for the
   figures — served by this API and inlined as rules, so the only requests
   are for the few files a phone actually uses. */
const CSS = `
${fontFacesForPage(["sans", "display"])}
:root{--marigold:#f5b82e;--marigold-hi:#ffc848;--ink:#10231c;--ink-2:#173128;
--cream:#f6f1e7;--sand:#e9e1d0;--paper:#fffdf8;--moss:#3f8f5f;--moss-deep:#2f6b47;--clay:#c2462e;
--ink-65:rgba(16,35,28,.65);--ink-50:rgba(16,35,28,.5);--ink-10:rgba(16,35,28,.1);--ink-6:rgba(16,35,28,.06);
--sans:${FONT.sans};--display:${FONT.display}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:var(--sans);
-webkit-font-smoothing:antialiased;line-height:1.5;padding:28px 16px 56px}
.sheet{max-width:600px;margin:0 auto;background:var(--paper);border-radius:24px;
box-shadow:0 0 0 1px var(--ink-6),0 1px 2px var(--ink-6);overflow:hidden}
.top{padding:28px 28px 0}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:700;
letter-spacing:-.03em;font-size:20px}
.dot{width:22px;height:22px;border-radius:50%;background:var(--marigold);flex:none}
/* The site's .label: small, spaced capitals that say what a figure is. */
.kind,th,.teyebrow,.part.phead .who{font-size:11.5px;font-weight:600;letter-spacing:.06em;
text-transform:uppercase}
.kind{margin-top:28px;color:var(--ink-50)}
h1{font-family:var(--display);font-size:44px;font-weight:800;letter-spacing:-.045em;
line-height:1.05;margin-top:8px;font-variant-numeric:tabular-nums}
.from{margin-top:10px;font-size:15px;color:var(--ink-65)}
/*
 * The naira charge, directly under the price it converts (section 9).
 *
 * Small and quiet, but not hidden: this is the figure that leaves the
 * payer's account, and finding it for the first time on a bank statement is
 * how somebody decides they were overcharged by whoever billed them.
 *
 * (No word here that a stranger's eye would catch. This stylesheet is shared
 * with the not-found page, which must give away nothing about whether a
 * token was ever real, and a leaked noun in a comment is enough.)
 */
.fx{margin-top:8px;font-size:13px;line-height:1.5;color:var(--ink-65);max-width:38ch}
.fx b{color:var(--ink);font-weight:600}
.from b{color:var(--ink);font-weight:600}
.pill{display:inline-flex;align-items:center;height:28px;margin-top:16px;padding:0 12px;
border-radius:999px;font-size:12.5px;font-weight:600}
.pill.due{background:var(--sand);color:var(--ink-2)}
.pill.paid{background:rgba(63,143,95,.13);color:var(--moss-deep)}
.pill.overdue{background:rgba(194,70,46,.1);color:var(--clay)}
.pill.cancelled{background:var(--ink-6);color:var(--ink-65)}
table{width:100%;border-collapse:collapse;margin-top:28px}
th{text-align:left;color:var(--ink-50);padding:0 28px 10px;border-bottom:1px solid var(--ink-10)}
th.r,td.r{text-align:right}
td{padding:14px 28px;border-bottom:1px solid var(--ink-6);font-size:15px;vertical-align:top}
td.r{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
td .qty{display:block;font-size:13px;color:var(--ink-50);margin-top:2px;font-variant-numeric:tabular-nums}
.totals{padding:16px 28px 0}
.row{display:flex;justify-content:space-between;gap:16px;font-size:15px;color:var(--ink-65);
padding:5px 0;font-variant-numeric:tabular-nums}
.row.grand{margin-top:8px;padding-top:14px;border-top:1px solid var(--ink);color:var(--ink);
font-family:var(--display);font-size:22px;font-weight:700;letter-spacing:-.03em}
.row.paidoff{color:var(--moss)}
.note{margin:22px 28px 0;padding:14px 16px;background:var(--cream);border-radius:14px;
font-size:14px;line-height:1.6;color:var(--ink-65);white-space:pre-wrap}
.pay{padding:28px 28px 4px}
/* The site's primary button: a marigold pill, the width of the page here
   because it is the only thing on it to press. */
button.pay-btn,a.pay-btn,button.tcopy{display:flex;align-items:center;justify-content:center;
width:100%;height:54px;padding:0 24px;border:0;border-radius:999px;background:var(--marigold);
color:var(--ink);font:600 16px/1 var(--sans);cursor:pointer;text-decoration:none;
transition:background-color .2s,transform .2s;-webkit-tap-highlight-color:transparent}
button.pay-btn:hover,a.pay-btn:hover,button.tcopy:hover{background:var(--marigold-hi)}
button.pay-btn:active,button.tcopy:active{transform:scale(.98)}
button:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button.pay-btn:disabled{opacity:.5;cursor:default}
.secure{margin-top:12px;text-align:center;font-size:13px;color:var(--ink-50)}
.banner{margin:28px 28px 4px;padding:16px 18px;border-radius:16px;font-size:14.5px;
line-height:1.55;text-align:center}
.banner.paid{background:rgba(63,143,95,.12);color:var(--moss-deep);font-weight:600}
.banner.cancelled{background:var(--ink-6);color:var(--ink-65)}
.banner.quote{background:var(--cream);color:var(--ink-65)}
.parts{padding:18px 28px 0}
.part{display:flex;justify-content:space-between;align-items:center;gap:16px;
padding:12px 0;border-bottom:1px solid var(--ink-6);font-size:14.5px}
.part:last-child{border-bottom:0}
.part .who{color:var(--ink-65)}
.part .amt{font-weight:600;font-variant-numeric:tabular-nums}
.part.done .who,.part.done .amt{color:var(--moss)}
.part.phead{border-bottom:0;padding-bottom:2px}
.part.phead .who{color:var(--ink-50)}
.part .tag{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;
background:var(--ink-6);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
color:var(--ink-65);font-weight:600;vertical-align:1px}
.part.done .tag{background:rgba(63,143,95,.12);color:var(--moss-deep)}
/* The date sits under the label rather than beside it: three things on one
   line wraps badly at 320px, and the label is what is being scanned. */
.part .on{display:block;font-size:12.5px;color:var(--ink-50);margin-top:3px}
/* The processor, as the site shows it: one quiet pill, not a boxed panel
   competing with the amount for attention. */
.trust{margin:26px 28px 0;text-align:center}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 10px;
border-radius:999px;background:#fff;box-shadow:inset 0 0 0 1px var(--ink-10);
font-size:11.5px;font-weight:500;color:var(--ink-65);white-space:nowrap}
.badge svg{width:14px;height:14px;color:var(--moss);flex:none}
.badge img{height:12px;width:auto;display:block}
.tsmall{margin:12px auto 0;max-width:420px;font-size:12.5px;line-height:1.6;color:var(--ink-50)}
.tsmall b{color:var(--ink-65);font-weight:600}
.files{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;padding:22px 28px 28px}
.files a{display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;
font-size:13.5px;font-weight:600;color:var(--ink);text-decoration:none;
box-shadow:inset 0 0 0 1.5px rgba(16,35,28,.2);transition:box-shadow .2s}
.files a:hover{box-shadow:inset 0 0 0 1.5px var(--ink)}
.foot{display:flex;align-items:center;justify-content:center;gap:8px;max-width:600px;
margin:20px auto 0;font-size:12.5px;color:var(--ink-50)}
.foot a{color:inherit;text-underline-offset:3px}
.foot svg{width:16px;height:16px;flex:none}
/* The transfer step is the one thing on this page that is an action rather
   than a document, so it sits on ink and everything above it stays paper —
   the same move as the pay panel on the site. */
.tcard{background:var(--ink);color:var(--cream);border-radius:24px;padding:24px 20px 20px;text-align:center}
.teyebrow{color:rgba(246,241,231,.5)}
.tamt{font-family:var(--display);font-size:17px;font-weight:700;letter-spacing:-.02em;
font-variant-numeric:tabular-nums}
.tbox{margin-top:16px;background:var(--ink-2);border-radius:16px;overflow:hidden;text-align:left}
.trow{display:flex;align-items:center;justify-content:space-between;gap:14px;
padding:13px 16px;border-top:1px solid rgba(246,241,231,.07)}
.trow:first-child{border-top:0}
.trow.wide{display:block}
/* The account number reads as one of the four details, on its line, in the
   same shape as the rest. It was on a line of its own at 26px, which made it
   look like a different kind of thing from the bank and the amount beside it. */
.tk{color:rgba(246,241,231,.5);font-size:13px;flex:none}
.tv{font-weight:600;text-align:right;color:var(--cream);min-width:0;font-size:14.5px}
.trow.wide .tv{text-align:left;margin-top:5px}
.tv .acct{font-family:var(--display);font-variant-numeric:tabular-nums;letter-spacing:.03em;
font-size:20px;font-weight:700;line-height:1.2}
button.tcopy{height:52px;margin-top:16px}
/* Copying the amount.
   The figure can carry kobo — 54,670.06 — because it was grossed up so the
   freelancer still receives the whole of what they billed. These accounts are
   matched on the amount as well as the number, so a mistyped kobo is not a
   short payment, it is a payment that never arrives and a page that waits
   forever. Nobody should have to retype that. The icon sits inside the row
   with the figure rather than under it, because it belongs to that number and
   not to the panel.
   (No mention here of what kind of document this is: the stylesheet is served
   with the not-found page too, and that page must not hint whether a token
   was ever real.) */
button.icopy{flex:none;display:grid;place-items:center;width:34px;height:34px;margin:-6px -6px -6px 0;
border:0;border-radius:10px;background:transparent;color:rgba(246,241,231,.55);cursor:pointer;
-webkit-tap-highlight-color:transparent}
button.icopy:hover,button.icopy:focus-visible{background:rgba(246,241,231,.08);color:var(--cream)}
button.icopy:active{transform:scale(.94)}
button.icopy svg{width:17px;height:17px;display:block;fill:none;stroke:currentColor;
stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
/* The tick replaces the sheets in place: swapping textContent, which is what
   the wide button does, would throw the icon away. */
button.icopy .i-yes{display:none}
button.icopy.done{color:#6fdc9c}
button.icopy.done .i-no{display:none}
button.icopy.done .i-yes{display:block}
.trow .tv{display:flex;align-items:center;justify-content:flex-end;gap:8px}
button.tcopy.done{background:var(--moss);color:var(--cream)}
.tfine{margin:16px 4px 0;font-size:13.5px;line-height:1.65;color:var(--ink-65);text-align:center}
.tfine strong{color:var(--ink);font-weight:600}
.twait{margin-top:16px;font-size:13px;color:rgba(246,241,231,.6);text-align:center;line-height:1.7}
.twait .dot{display:inline-block;vertical-align:baseline;width:7px;height:7px;
border-radius:50%;background:var(--marigold);margin-right:8px;animation:pulse 1.8s ease-in-out infinite}
.twait .tleft{color:rgba(246,241,231,.45)}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.twait .dot{animation:none;opacity:.8}}
.tussd{margin-top:12px;text-align:center;font-size:13.5px;color:var(--ink-65)}
@media(max-width:520px){
  body{padding:12px 10px 44px}
  .sheet{border-radius:20px}
  .top{padding:22px 20px 0}
  .kind{margin-top:24px}
  h1{font-size:38px}
  th{padding:0 20px 10px}
  td{padding:13px 20px}
  .totals,.parts{padding-left:20px;padding-right:20px}
  .note,.trust,.banner{margin-left:20px;margin-right:20px}
  .pay{padding:24px 12px 4px}
  .files{padding:20px 20px 24px}
  .tcard{padding:22px 14px 16px;border-radius:20px}
  .trow{padding:12px 13px}
  .tv .acct{font-size:18px;letter-spacing:.02em}
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
/*
 * The copy buttons on their own, for the bank-details panel: it has the same
 * account and amount to copy as the transfer panel, and none of its countdown
 * or polling, because nothing will confirm a direct transfer.
 */
const COPY_JS = `
document.addEventListener('click', function (e) {
  var b = e.target.closest('button.copy');
  if (!b) return;
  var text = b.getAttribute('data-copy') || '';
  var done = function () {
    if (b.classList.contains('icopy')) {
      b.classList.add('done');
      setTimeout(function () { b.classList.remove('done'); }, 1600);
      return;
    }
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
`;

const TRANSFER_JS = `
(function () {
  var box = document.querySelector('.transfer');
  if (!box) return;

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button.copy');
    if (!b) return;
    var text = b.getAttribute('data-copy') || '';
    var done = function () {
      // An icon button says so by swapping its picture, which CSS does from
      // the class. Rewriting textContent would throw the icon away and leave
      // the word "Copied" where a 34px square used to be.
      if (b.classList.contains('icopy')) {
        b.classList.add('done');
        setTimeout(function () { b.classList.remove('done'); }, 1600);
        return;
      }
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
  // What this page was drawn with. The reload happens when the server's
  // figure stops matching it, which is once per payment — asking "has
  // anything been paid" instead reloaded for ever on a part-paid invoice,
  // because the answer was yes before the page was even drawn.
  var drawnWith = box.getAttribute('data-paid') || '0';
  var wait = 3000;
  function poll() {
    fetch('/i/' + token + '/status', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && String(d.paidKobo) !== drawnWith) { location.reload(); return; }
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

/**
 * Something that went wrong on the last attempt to pay.
 *
 * Always transient by the time it reaches here. A standing reason a card
 * cannot be taken is `cardReady`, not an error: it has to be known before the
 * button is drawn rather than reported after somebody has pressed it.
 */
export type PayError = { text: string };

/**
 * A figure in the currency it was agreed in, falling back to naira.
 *
 * Every line on an invoice priced abroad carries both: the kobo that will be
 * charged and the cents that were quoted. The client reads the second,
 * because the second is what they said yes to — a client who agreed to $200
 * for the logo should not have to check whether ₦265,400 is the same thing.
 */
const money = (doc: PublicDocument, kobo: number, minor: number | null): string =>
  doc.foreign && minor !== null ? formatMoney(minor, doc.foreign.currency) : formatNaira(kobo);

/**
 * The sentence under the headline on an invoice priced abroad (section 9).
 *
 * It has to say three things and no more. What will actually be charged,
 * because that is the figure on their statement and it is in naira. That
 * their own bank does the conversion, because ours is not the rate they will
 * be charged at. And that the bank may add its own fee, because it very
 * often does and a client who finds that out from the statement blames the
 * person who sent the invoice.
 *
 * What it must never say is anything about the freelancer's side: what they
 * receive, what Paystack takes, what Balans takes. The client agreed to a
 * price, not to somebody else's margins.
 */
function convertedLine(doc: PublicDocument): string {
  if (!doc.foreign) return "";
  return `<p class="fx">Charged in Naira as <b>${formatNaira(doc.totalKobo)}</b>. Your bank converts this and may apply its own exchange rate or fees.</p>`;
}

export function renderDocument(
  doc: PublicDocument,
  today: Civil,
  opts: {
    token: string;
    error?: PayError;
    transfer?: TransferPanel | null;
    /** Whether a card can actually be taken. Only consulted on a foreign invoice. */
    cardReady?: boolean;
    /**
     * Where this page was opened from, for its own links. A quote is opened
     * at balans.ng/q/…, which the site passes through to this API; its PDF
     * link has to stay under /q/ or it would point at a path the site does
     * not forward.
     */
    base?: "/i" | "/q";
  } = { token: "" },
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
        l.qty === 1 ? "" : `<span class="qty">${l.qty} &times; ${money(doc, l.unitAmountKobo, l.originalAmountMinor == null ? null : Math.round(l.originalAmountMinor / l.qty))}</span>`
      }</td><td class="r">${money(doc, l.amountKobo, l.originalAmountMinor ?? null)}</td></tr>`,
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
      // Larger than it was. This is the only thing on the page that says who
      // is asking, above an amount and a card button, and at 28px it read as
      // a footnote on the surface that has to carry the most trust.
      logoAvailable() ? logoSvg("40px") : `<span class="dot"></span>balans`
    }</div>
    <div class="kind">${label} ${doc.number}</div>
    <h1>${doc.foreign ? formatMoney(agreedTotalMinor(doc.foreign.amountMinor, doc.subtotalKobo, doc.vatKobo), doc.foreign.currency) : formatNaira(doc.totalKobo)}</h1>
    ${convertedLine(doc)}
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
      /*
       * What is owed stays in naira, always, even on an invoice priced
       * abroad. The headline says what was agreed; this says what is left to
       * pay, and what is left to pay is a naira figure — part-paid in naira,
       * charged in naira. Converting it back would produce a dollar amount
       * that nobody agreed to and that moves with the rate.
       */
      doc.amountPaidKobo > 0
        ? `<div class="row"><span>Total</span><span>${formatNaira(doc.totalKobo)}</span></div>
           <div class="row paidoff"><span>Paid</span><span>&minus;${formatNaira(doc.amountPaidKobo)}</span></div>
           <div class="row grand"><span>Still owed</span><span>${formatNaira(outstanding)}</span></div>`
        : `<div class="row grand"><span>Total</span><span>${formatNaira(doc.totalKobo)}</span></div>`
    }
  </div>

  ${partsBlock(doc, today)}
  ${doc.notes ? `<div class="note">${esc(doc.notes)}</div>` : ""}
  ${payBlock(doc, can, payableNowKobo(doc), opts, payableLabel(doc))}
  ${trustBlock(doc)}
  <div class="files">
    ${
      // F8: a payment request is "a lightweight payable with no PDF". There is
      // nothing itemised to render, and offering one implies there is.
      doc.type === "payment_request"
        ? ""
        : `<a href="${opts.base ?? "/i"}/${esc(opts.token)}/pdf">Download ${label.toLowerCase()} (PDF)</a>`
    }
    ${
      doc.amountPaidKobo > 0
        ? `<a href="/i/${esc(opts.token)}/receipt">Download receipt</a>`
        : ""
    }
  </div>
</div>
<p class="foot">${markSvg("16px")}<span>Invoiced with <a href="https://balans.ng">Balans</a></span></p>
${opts.transfer ? `<script>${TRANSFER_JS}</script>` : doc.bank && can.ok === false ? `<script>${COPY_JS}</script>` : ""}
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
function partsBlock(doc: PublicDocument, today: Civil): string {
  if (!doc.parts.length) return "";

  /*
   * A quote is proposing these, not billing them.
   *
   * The tags said "Due now" and "Later" whatever the document was, so a
   * quote read "Part 1 of 2 — DUE NOW — ₦100,000" a few centimetres above
   * "This is a quote, not an invoice." Nothing is due on a quote: it is an
   * offer, it cannot be paid, and the page refuses to take money for one.
   * A client reading both either thinks they owe money today or thinks the
   * document is broken, and neither is a good way to open a job.
   *
   * So a quote shows the same schedule with no tags on it. The figures are
   * the point — what accepting would commit them to — and every word about
   * timing on a quote would be a term nobody has agreed yet.
   */
  const quote = doc.type === "quote";

  const rows = doc.parts
    .map((p, i) => {
      const done = p.status === "paid";
      const tag = quote ? "" : done ? "Paid" : p.status === "payable" ? "Due now" : "Later";
      /*
       * The date, for every part but the first.
       *
       * "Later" is not an answer to when, and it was the only thing a client
       * with a deposit invoice had. The first part is tagged "Due now", which
       * says today more plainly than today's date would — and on a quote
       * there are no tags at all, so every row carries its date.
       */
      const on = p.dueOn && (quote || i > 0) ? formatFriendly(p.dueOn, today) : null;
      return `<div class="part${done && !quote ? " done" : ""}">
        <span class="who">${esc(p.label)}${tag ? `<span class="tag">${tag}</span>` : ""}${
          on ? `<span class="on">${esc(on)}</span>` : ""
        }</span>
        <span class="amt">${formatNaira(p.amountKobo)}</span>
      </div>`;
    })
    .join("");

  // Named on a quote, because without the tags the rows need to say what they
  // are. On an invoice the tags already do that.
  const head = quote ? `<div class="part phead"><span class="who">Payment plan</span></div>` : "";

  return `<div class="parts">${head}${rows}</div>`;
}

function payBlock(
  doc: PublicDocument,
  can: ReturnType<typeof payable>,
  amount: number,
  opts: {
    token: string;
    error?: PayError;
    transfer?: TransferPanel | null;
    cardReady?: boolean;
  },
  partLabel: string | null,
): string {
  if (can.ok) {
    // Details already issued: show them instead of asking again. A client who
    // has gone to their banking app and come back must meet the same account.
    if (opts.transfer) return transferBlock(doc, opts.transfer, opts.token);

    /*
     * No button when a card cannot be taken at all.
     *
     * The invoice is payable in principle — `can.ok` — so the button used to
     * come back regardless, and on a foreign invoice whose sender has no
     * usable Paystack account it came back under the words "Card payment is
     * not available on this invoice yet". Two contradictory instructions
     * given to a stranger about their own money; the one who met it pressed
     * six times in fifteen seconds.
     *
     * Driven by the condition rather than by the last failure. Reading it off
     * the error was the obvious fix and the wrong one: that error travels in
     * the query string so a reload keeps it, which left the page dead even
     * after the cause was fixed.
     */
    if (doc.foreign && opts.cardReady === false) {
      return `<div class="banner cancelled">Card payment is not available on this ${LABEL[
        doc.type
      ].toLowerCase()} yet. Please contact ${esc(doc.businessName)}.</div>`;
    }

    // A plain form post, so the button works with no JavaScript at all.
    return `<div class="pay">
    ${opts.error ? `<p class="banner cancelled" style="margin:0 0 14px">${esc(opts.error.text)}</p>` : ""}
    <form method="post" action="/i/${esc(opts.token)}/pay">
      <button class="pay-btn" type="submit">Pay ${formatNaira(amount)}${
        /*
         * In naira, on both kinds of invoice, and section 9 spells it out:
         * "Pay ₦663,500 by card". The headline is the price two people
         * agreed; this button is a figure about to leave a bank account, and
         * putting "$500" on it would be a button that charges a different
         * number than it says.
         */
        doc.foreign ? " by card" : ""
      }${partLabel ? ` &middot; ${esc(partLabel)}` : ""}</button>
    </form>
    <p class="secure">${
      doc.foreign
        ? `Paid by card to ${esc(doc.businessName)}. Takes about a minute.`
        : `Pay by bank transfer to ${esc(doc.businessName)}. Takes about a minute.`
    }</p>
  </div>`;
  }

  switch (can.why) {
    case "bank_details":
      return bankBlock(doc, amount, partLabel);
    case "paid":
      return `<div class="banner paid">Paid in full. Nothing more to do.</div>`;
    case "cancelled":
      return `<div class="banner cancelled">This ${LABEL[doc.type].toLowerCase()} was cancelled and cannot be paid.</div>`;
    case "quote":
      return `<div class="banner quote">This is a quote, not an invoice. Reply to ${esc(doc.businessName)} to accept it.</div>`;
    case "quote_expired":
      return `<div class="banner cancelled">This quote has expired. Contact ${esc(doc.businessName)} for an up-to-date price.</div>`;
    case "quote_cancelled":
      return `<div class="banner cancelled">This quote was withdrawn by ${esc(doc.businessName)}.</div>`;
    case "quote_converted":
      // Already accepted. Saying so is what stops somebody accepting twice,
      // and the invoice reaches them by its own link.
      return `<div class="banner quote">This quote has been accepted and invoiced. ${esc(doc.businessName)} will have sent you the invoice.</div>`;
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

  /*
   * The figure as a banking app wants it typed: digits, a dot, and nothing
   * else. No naira sign, no thousands separators, and no trailing ".00" —
   * every one of those is something to delete before the transfer can be
   * sent, and this exists to save exactly that.
   */
  const typed =
    t.amountKobo % 100 === 0
      ? String(t.amountKobo / 100)
      : (t.amountKobo / 100).toFixed(2);

  /*
   * Two sheets of paper, and a tick. Both are in the button and CSS shows
   * whichever applies, because the copy handler swaps a class and cannot
   * rebuild an icon.
   */
  const copyIcon = (what: string, value: string) =>
    `<button class="icopy copy" type="button" data-copy="${esc(value)}" aria-label="Copy the ${what}">` +
    `<svg class="i-no" viewBox="0 0 24 24" aria-hidden="true">` +
    `<rect x="9" y="9" width="11" height="11" rx="2.5"/>` +
    `<path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"/></svg>` +
    `<svg class="i-yes" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>` +
    `</button>`;

  const row = (k: string, v: string, cls = "") =>
    `<div class="trow${cls ? ` ${cls}` : ""}"><span class="tk">${k}</span><span class="tv">${v}</span></div>`;

  return `<div class="pay transfer" data-token="${esc(token)}" data-expires="${t.expiresInMs}"
  data-paid="${doc.amountPaidKobo}">
  <div class="tcard">
    <p class="teyebrow">Pay by bank transfer</p>

    <div class="tbox">
      ${row("Bank", esc(t.bankName))}
      ${row("Account number", `<span class="acct">${esc(t.accountNumber)}</span>`)}
      ${t.accountName ? row("Account name", esc(t.accountName)) : ""}
      ${row("Amount", `<span class="tamt">${amount}</span>${copyIcon("amount", typed)}`)}
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
 * The sender's own account, on a naira invoice (see bank-details.ts).
 *
 * The same panel as the transfer one, because it asks the same thing of the
 * client: an account, a name, an exact amount. What is different is said
 * plainly underneath. This is the business's own account, so the name the
 * client's bank shows them is one they recognise — and nothing here watches
 * for the money, so the client should not expect a receipt from Balans until
 * the sender confirms it.
 */
function bankBlock(doc: PublicDocument, amountKobo: number, partLabel: string | null): string {
  const k = doc.bank!;
  const amount = formatNaira(amountKobo);
  const typed = amountKobo % 100 === 0 ? String(amountKobo / 100) : (amountKobo / 100).toFixed(2);
  const copyIcon = (what: string, value: string) =>
    `<button class="icopy copy" type="button" data-copy="${esc(value)}" aria-label="Copy the ${what}">` +
    `<svg class="i-no" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/>` +
    `<path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"/></svg>` +
    `<svg class="i-yes" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg></button>`;
  const row = (key: string, v: string) =>
    `<div class="trow"><span class="tk">${key}</span><span class="tv">${v}</span></div>`;

  return `<div class="pay bankpay">
  <div class="tcard">
    <p class="teyebrow">Pay by bank transfer${partLabel ? ` &middot; ${esc(partLabel)}` : ""}</p>
    <div class="tbox">
      ${row("Bank", esc(k.bankName))}
      ${row("Account number", `<span class="acct">${esc(k.accountNumber)}</span>`)}
      ${row("Account name", esc(k.accountName))}
      ${row("Amount", `<span class="tamt">${amount}</span>${copyIcon("amount", typed)}`)}
    </div>
    <button class="tcopy copy" type="button" data-copy="${esc(k.accountNumber)}">Copy account number</button>
  </div>
  <p class="tfine">Send <strong>${amount}</strong> to ${esc(doc.businessName)}&rsquo;s own account.
    Payments made directly to this account are not tracked automatically &mdash; ask
    ${esc(doc.businessName)} to confirm once you have paid.</p>
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
  /*
   * Whoever is actually going to take the money.
   *
   * Naira is collected by Monnify and anything else by Paystack (section 8),
   * and this badge is the one place the page tells a stranger where the card
   * details they are about to type are going. It said Monnify on every
   * document, including a dollar invoice whose only payment button opens
   * Paystack's checkout — a claim the very next screen contradicts.
   */
  const processor: Processor = doc.foreign ? "paystack" : "monnify";
  const processorName = doc.foreign ? "Paystack" : "Monnify";
  const mark = processorLogo(processor);

  /*
   * A quote is not a payment, so it must not be described as one.
   *
   * This block said "Payments processed by Monnify" and "This payment
   * settles directly to..." on every document, including a quote that
   * cannot be paid at all. The disclosure itself still belongs — we are
   * not a bank and hold nothing, and that is true whatever the document is
   * — but the payment it describes has to be the conditional one.
   */
  /*
   * Only a quote still open gets the conditional sentence.
   *
   * "If you accept this quote" on one that has expired, been withdrawn or
   * already been invoiced invites the same acceptance the banner above just
   * ruled out. A quote that is finished keeps the disclosure and drops the
   * invitation, because the disclosure is true of every document and the
   * invitation is true of one.
   */
  /*
   * A naira invoice paid to the sender's own account has no processor to
   * name: the money goes from the client's bank to theirs, and saying
   * "processed by Monnify" beside an account number would be untrue.
   */
  if (doc.bank && doc.type !== "quote") {
    return `<div class="trust">
    <p class="tsmall">Balans is not a bank and does not hold your money. This invoice is paid straight
      to the bank account of <b>${esc(doc.businessName)}</b>.</p>
  </div>`;
  }

  const quote = doc.type === "quote";
  const open =
    quote &&
    doc.status !== "cancelled" &&
    doc.status !== "expired" &&
    doc.status !== "converted" &&
    doc.status !== "accepted";

  return `<div class="trust">
    <span class="badge">
      <!-- An arrow into a bank, as on the site: what actually happens to the
           money. A shield said "protected", which nothing here promises. -->
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 14h12M3.5 11.5v-4M8 11.5v-4M12.5 11.5v-4M8 1.5 14 5H2l6-3.5Z" stroke="currentColor"
              stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      ${quote ? "Payments handled by" : "Payments processed by"}
      ${
        mark
          ? `<img src="${mark}" alt="${processorName}" width="74" height="12">`
          : `<b>${processorName}</b>`
      }
    </span>
    <p class="tsmall">
      Balans is not a bank and does not hold your money.${
        open
          ? ` If you accept this quote, payment settles directly to the bank account of <b>${esc(doc.businessName)}</b>.`
          : quote
            ? ` Payments to <b>${esc(doc.businessName)}</b> settle directly to their own bank account.`
            : ` This payment settles directly to the bank account of <b>${esc(doc.businessName)}</b>.`
      }
    </p>
  </div>`;
}

/** A 404 that does not confirm whether the token was ever real. */
/**
 * Paying for Pro: the account to transfer into, and nothing else.
 *
 * The account is Paystack's, opened for this payment alone, so it is shown
 * with the amount to send and when it stops working — a transfer after that
 * does not land. The page asks the server every few seconds whether the money
 * has arrived and moves on to the success page by itself, so nobody is left
 * refreshing a page that has already done its job.
 */
export function renderProTransfer(o: {
  bankName: string;
  accountNumber: string;
  accountName: string;
  amountKobo: number;
  expiresAt: Date;
  /** Where the page asks whether it has been paid. */
  statusUrl: string;
  /** Where it goes once it has. */
  doneUrl: string;
}): string {
  const amount = formatNaira(o.amountKobo);
  const typed = o.amountKobo % 100 === 0 ? String(o.amountKobo / 100) : (o.amountKobo / 100).toFixed(2);
  const until = o.expiresAt.toLocaleTimeString("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const copyIcon = (what: string, value: string) =>
    `<button class="icopy copy" type="button" data-copy="${esc(value)}" aria-label="Copy the ${what}">` +
    `<svg class="i-no" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/>` +
    `<path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"/></svg>` +
    `<svg class="i-yes" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg></button>`;
  const row = (key: string, v: string) =>
    `<div class="trow"><span class="tk">${key}</span><span class="tv">${v}</span></div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>Pay for Balans Pro</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}
.wait{display:flex;align-items:center;gap:10px;margin-top:18px;font-size:14px;color:var(--ink-65)}
.wait i{width:9px;height:9px;border-radius:50%;background:var(--marigold);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
</style></head><body>
<div class="sheet"><div class="top" style="padding-bottom:28px">
  <div class="brand">${logoAvailable() ? logoSvg("28px") : `<span class="dot"></span>balans`}</div>
  <p class="kind">Balans Pro &middot; one month</p>
  <h1>${amount}</h1>
  <p class="from">Transfer this exact amount from any bank app. Pro switches on the moment it lands.</p>
  <div class="pay bankpay" style="margin-top:22px">
    <div class="tcard">
      <p class="teyebrow">Pay by bank transfer</p>
      <div class="tbox">
        ${row("Bank", esc(o.bankName))}
        ${row("Account number", `<span class="acct">${esc(o.accountNumber)}</span>`)}
        ${row("Account name", esc(o.accountName))}
        ${row("Amount", `<span class="tamt">${amount}</span>${copyIcon("amount", typed)}`)}
      </div>
      <button class="tcopy copy" type="button" data-copy="${esc(o.accountNumber)}">Copy account number</button>
    </div>
    <p class="tfine">This account is for this payment only and closes at <strong>${esc(until)}</strong>.
      Your receipt comes to your email and to WhatsApp once it is paid.</p>
  </div>
  <p class="wait"><i></i>Waiting for your transfer&hellip;</p>
</div></div>
<p class="foot">${markSvg("16px")}<a href="https://balans.ng">balans.ng</a></p>
<script>${COPY_JS}
(function () {
  var tries = 0;
  function ask() {
    tries += 1;
    fetch(${JSON.stringify(o.statusUrl)}, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (b) { if (b && b.active) location.replace(${JSON.stringify(o.doneUrl)}); })
      .catch(function () {})
      .then(function () { if (tries < 720) setTimeout(ask, 5000); });
  }
  setTimeout(ask, 5000);
})();
</script>
</body></html>`;
}

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>Not found</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body>
<div class="sheet"><div class="top" style="padding-bottom:32px">
  <div class="brand">${logoAvailable() ? logoSvg("28px") : `<span class="dot"></span>balans`}</div>
  <h1 style="margin-top:22px">Nothing here</h1>
  <p class="from">This link has expired, or it was never quite right. Ask whoever sent it for a new one.</p>
</div></div>
<p class="foot">${markSvg("16px")}<a href="https://balans.ng">balans.ng</a></p>
</body></html>`;
}

const compare = (a: Civil, b: Civil): number =>
  Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
