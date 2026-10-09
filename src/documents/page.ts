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

import { applyBrand, brandTokens } from "../brand/colour.ts";
import { clientNumber } from "./client-number.ts";
import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { formatMoney, INFO } from "../../core/currency.ts";
import { agreedTotalMinor } from "../../core/exchange.ts";
import { outstandingKobo, payable, payableLabel, payableNowKobo, type PublicDocument } from "./public.ts";
import { logoAvailable, logoSvg, markSvg, processorLogo, type Processor } from "../brand/logo.ts";
import { FONT, fontFacesForPage } from "../pdf/fonts.ts";
import { env } from "../config.ts";

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
--cream:#f6f1e7;--sand:#e9e1d0;--paper:#ffffff;--moss:#3f8f5f;--moss-deep:#2f6b47;--clay:#c2462e;
--ink-80:rgba(16,35,28,.8);--ink-65:rgba(16,35,28,.65);--ink-50:rgba(16,35,28,.5);--ink-40:rgba(16,35,28,.4);
--ink-10:rgba(16,35,28,.1);--ink-6:rgba(16,35,28,.06);--ink-3:rgba(16,35,28,.03);
--line:rgba(16,35,28,.08);
--lift:0 0 0 1px rgba(16,35,28,.06),0 1px 2px rgba(16,35,28,.05),0 12px 32px -16px rgba(16,35,28,.18);
--sans:${FONT.sans};--display:${FONT.display}}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--cream);color:var(--ink);font-family:var(--sans);font-size:15px;
-webkit-font-smoothing:antialiased;line-height:1.5;padding:0 0 56px}
/*
 * The page, as a hosted payment page is laid out: a band of colour across
 * the top, and the cards rising out of it. On a phone the cards stack in the
 * order somebody reads them — what is owed, what it was for, how to pay it.
 * From 920px the paying sits in its own column and stays put while the
 * details scroll beside it.
 */
.band{height:208px;background:var(--ink);position:relative;overflow:hidden}
.band::after{content:"";position:absolute;inset:auto 0 0;height:1px;background:rgba(246,241,231,.08)}
.shell{position:relative;max-width:560px;margin:-168px auto 0;padding:0 16px;display:grid;gap:14px}
.card{background:var(--paper);border-radius:20px;box-shadow:var(--lift)}
@media(min-width:920px){
  .band{height:248px}
  .shell{max-width:1060px;margin-top:-188px;padding:0 32px;grid-template-columns:minmax(0,1fr) 400px;gap:24px;align-items:start}
  .summary{grid-column:1;grid-row:1}
  .items{grid-column:1;grid-row:2}
  .side{grid-column:2;grid-row:1 / span 2;position:sticky;top:24px}
}
.summary{padding:26px 26px 22px}
.ident{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:700;
letter-spacing:-.03em;font-size:20px;min-width:0}
.dot{width:22px;height:22px;border-radius:50%;background:var(--marigold);flex:none}
.own-logo{display:block;max-height:44px;max-width:200px;width:auto;height:auto;object-fit:contain}
.own-name{font-size:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kind{font-size:13px;font-weight:600;color:var(--ink-50);letter-spacing:.01em;white-space:nowrap}
.doctitle{margin-top:22px;font-size:15px;font-weight:600;color:var(--ink-80)}
.eyebrow{margin-top:26px;font-size:13px;color:var(--ink-50)}
.doctitle + .eyebrow{margin-top:6px}
h1{font-family:var(--display);font-size:46px;font-weight:800;letter-spacing:-.045em;
line-height:1.02;margin-top:6px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.from{margin-top:10px;font-size:15px;color:var(--ink-65)}
.from b{color:var(--ink);font-weight:600}
.fx{margin-top:8px;font-size:13px;line-height:1.5;color:var(--ink-65);max-width:38ch}
.fx b{color:var(--ink);font-weight:600}
/* Status, as a small badge with a dot of its colour. */
.pill{display:inline-flex;align-items:center;gap:7px;height:28px;margin-top:14px;padding:0 11px 0 10px;
border-radius:999px;font-size:13px;font-weight:600;white-space:nowrap}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.pill.due{background:rgba(245,184,46,.16);color:#8a5a00}
.pill.paid{background:rgba(63,143,95,.13);color:var(--moss-deep)}
.pill.overdue{background:rgba(194,70,46,.1);color:var(--clay)}
.pill.cancelled{background:var(--ink-6);color:var(--ink-65)}
.facts{margin-top:22px;border-top:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr;gap:0 20px}
.facts>div{padding-top:14px;min-width:0}
.facts dt{font-size:12.5px;color:var(--ink-50)}
.facts dd{margin-top:2px;font-size:14.5px;font-weight:600;overflow-wrap:anywhere}
/* The work, as a table in its own card. */
.items{padding:6px 0 4px;overflow:hidden}
.sect{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 26px 6px;
font-size:13px;font-weight:600;color:var(--ink-50)}
table{width:100%;border-collapse:collapse}
th{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;text-align:left;color:var(--ink-40);
padding:10px 26px 10px;border-bottom:1px solid var(--line)}
th.r,td.r{text-align:right}
td{padding:15px 26px;border-bottom:1px solid var(--line);font-size:15px;vertical-align:top}
tbody tr:last-child td{border-bottom:0}
td.r{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
td .qty{display:block;font-size:13px;color:var(--ink-50);margin-top:2px;font-variant-numeric:tabular-nums}
.totals{margin:0 26px;padding:14px 0 18px;border-top:1px solid var(--line)}
.row{display:flex;justify-content:space-between;gap:16px;font-size:14.5px;color:var(--ink-65);
padding:4px 0;font-variant-numeric:tabular-nums}
.row.grand{margin-top:8px;padding-top:12px;border-top:1px solid var(--line);color:var(--ink);
font-family:var(--display);font-size:20px;font-weight:700;letter-spacing:-.025em}
.row.paidoff{color:var(--moss)}
.totals .row.grand:first-child{margin-top:0;padding-top:4px;border-top:0}
.note{margin:0 26px 22px;padding:14px 16px;background:var(--cream);border-radius:14px;
font-size:14px;line-height:1.6;color:var(--ink-65);white-space:pre-wrap}
/* The parts of a split, under the amount they divide. */
.parts{margin-top:18px;border-radius:14px;background:var(--ink-3);box-shadow:inset 0 0 0 1px var(--line);padding:4px 14px}
.part{display:flex;justify-content:space-between;align-items:center;gap:16px;
padding:11px 0;border-bottom:1px solid var(--line);font-size:14.5px}
.part:last-child{border-bottom:0}
.part .who{color:var(--ink-65)}
.part .amt{font-weight:600;font-variant-numeric:tabular-nums}
.part.done .who,.part.done .amt{color:var(--moss)}
.part.phead{border-bottom:0;padding-bottom:0}
.part.phead .who{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-40)}
.part .tag{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;
background:var(--ink-6);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
color:var(--ink-65);font-weight:600;vertical-align:1px}
.part.done .tag{background:rgba(63,143,95,.12);color:var(--moss-deep)}
.part .on{display:block;font-size:12.5px;color:var(--ink-50);margin-top:3px}
/* The paying column. */
.side{display:grid;gap:16px;align-content:start;background:var(--paper);border-radius:20px;box-shadow:var(--lift);padding:18px}
/* Everything in the paying column shares its card, so nothing in it is
   framed twice and none of it ever sits on the band. */
.side .paycard,.side .pay.own{box-shadow:none;padding:0;border-radius:0;background:none}
.side .banner{box-shadow:none;background:var(--cream)}
.side .banner.paid{background:#eef7f1;box-shadow:none}
.side .trybalans{box-shadow:none;background:var(--cream)}
.side .files{padding-top:16px;border-top:1px solid var(--line)}
.side .trust{padding:0}
.side .tfine{margin:12px 2px 0}
.pay{padding:0}
.paycard{padding:22px}
.teyebrow{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.pay.own{background:var(--paper);border-radius:20px;box-shadow:var(--lift);padding:22px}
.pay.own .teyebrow{color:var(--ink-50)}
.pay.own .own-amt{margin-top:6px;font-family:var(--display);font-size:22px;font-weight:800;letter-spacing:-.03em}
.pay.own .own-details{margin-top:12px;padding:14px 16px;border-radius:14px;background:var(--cream);
font-size:15.5px;line-height:1.55;white-space:normal;overflow-wrap:anywhere;user-select:all}
.pay.own .tsmall{text-align:left;margin:12px 0 0;max-width:none}
/* The site's primary button: a marigold pill. */
button.pay-btn,a.pay-btn,button.tcopy{display:flex;align-items:center;justify-content:center;gap:8px;
width:100%;height:54px;padding:0 24px;border:0;border-radius:999px;background:var(--marigold);
color:var(--ink);font:600 16px/1 var(--sans);cursor:pointer;text-decoration:none;
box-shadow:inset 0 -2px 0 rgba(16,35,28,.12);
transition:background-color .2s,transform .15s;-webkit-tap-highlight-color:transparent}
button.pay-btn:hover,a.pay-btn:hover,button.tcopy:hover{background:var(--marigold-hi)}
button.pay-btn:active,a.pay-btn:active,button.tcopy:active{transform:scale(.985)}
button:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button.pay-btn:disabled{opacity:.5;cursor:default}
.lock{width:14px;height:14px;flex:none;margin-top:2px}
.secure{margin-top:12px;display:flex;align-items:flex-start;justify-content:center;gap:6px;
font-size:13px;color:var(--ink-50);text-align:center}
.banner{padding:18px 20px;border-radius:20px;font-size:14.5px;line-height:1.55;text-align:center;
background:var(--paper);box-shadow:var(--lift);color:var(--ink-65)}
.banner.paid{background:#eef7f1;color:var(--moss-deep);font-weight:600;box-shadow:0 0 0 1px rgba(63,143,95,.18)}
.banner.paid::before{content:"";display:block;width:34px;height:34px;margin:2px auto 10px;border-radius:50%;
background:var(--moss) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5 10 17.5 19 7.5'/%3E%3C/svg%3E") center/18px no-repeat}
.banner.cancelled{color:var(--ink-65)}
.banner.quote{color:var(--ink-65)}
.trybalans{display:block;padding:14px 16px;border-radius:16px;background:var(--paper);box-shadow:var(--lift);
color:var(--ink);text-decoration:none;font-size:14px;line-height:1.45;text-align:center}
.trybalans b{color:var(--ink);white-space:nowrap}
/* Who handles the money, said once, quietly. */
.trust{text-align:center;padding:2px 8px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 10px;
border-radius:999px;background:var(--paper);box-shadow:inset 0 0 0 1px var(--ink-10);
font-size:11.5px;font-weight:500;color:var(--ink-65);white-space:nowrap}
.badge svg{width:14px;height:14px;color:var(--moss);flex:none}
.badge img{height:12px;width:auto;display:block}
.badge svg.psmark{width:12px;height:12px;margin-right:-3px}
.tsmall{margin:10px auto 0;max-width:420px;font-size:12.5px;line-height:1.6;color:var(--ink-50)}
.tsmall b{color:var(--ink-65);font-weight:600}
.files{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.files a{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 16px 0 14px;border-radius:999px;
font-size:13.5px;font-weight:600;color:var(--ink);text-decoration:none;background:var(--paper);
box-shadow:inset 0 0 0 1px var(--ink-10);transition:box-shadow .2s}
.files a:hover{box-shadow:inset 0 0 0 1px var(--ink-40)}
.files svg{width:15px;height:15px;flex:none}
.foot{display:flex;align-items:center;justify-content:center;gap:8px;max-width:600px;
margin:28px auto 0;padding:0 16px;font-size:12.5px;line-height:1.5;color:var(--ink-50);text-align:center}
.foot a{color:inherit;text-underline-offset:3px}
.foot svg{width:16px;height:16px;flex:none}
.foot b{color:var(--ink-65);font-weight:600}
/* The step before a card is charged in naira for a foreign price. Opened by
   :target, so it needs no JavaScript. */
.modal{display:none;position:fixed;inset:0;z-index:10;background:rgba(16,35,28,.5);
-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
align-items:flex-end;justify-content:center;padding:12px}
.modal:target{display:flex;animation:fade .2s ease-out}
.modal:target .msheet{animation:rise .32s cubic-bezier(.16,1,.3,1)}
@keyframes fade{from{opacity:0}}
@keyframes rise{from{transform:translateY(24px);opacity:0}}
.msheet{width:100%;max-width:440px;background:var(--paper);border-radius:24px;padding:26px 22px 18px;
box-shadow:0 24px 64px rgba(16,35,28,.3)}
.mfield{display:block;margin:0 0 14px;font-size:13px;font-weight:600;color:var(--ink-65)}
.mfield input{display:block;width:100%;margin-top:6px;height:48px;padding:0 14px;border-radius:14px;
border:1px solid var(--ink-10);background:#fff;font:400 16px/1 var(--sans);color:var(--ink)}
.mfield input:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px rgba(16,35,28,.08)}
@media (min-width:600px){.modal{align-items:center}}
.msheet h2{margin:0;font:700 22px/1.2 var(--display);letter-spacing:-.02em}
.msheet p{margin:10px 0 0;font-size:14.5px;line-height:1.55;color:var(--ink-65)}
.msheet p b{color:var(--ink);font-weight:600}
.mrows{margin:18px 0 20px;padding:12px 16px;border-radius:16px;background:var(--cream)}
.mrows .row{padding:5px 0}
.mrows .row b{color:var(--ink);font-variant-numeric:tabular-nums}
.mclose{display:block;margin-top:10px;padding:12px;text-align:center;font-size:14px;font-weight:600;
color:var(--ink-65);text-decoration:none}
/* The transfer panel, on ink: the one thing here that is an action. */
.tcard{background:var(--ink);color:var(--cream);border-radius:20px;padding:22px 18px 18px;text-align:center;
box-shadow:0 18px 40px -20px rgba(16,35,28,.6)}
.tcard .teyebrow{color:rgba(246,241,231,.55)}
.tamt{font-family:var(--display);font-size:17px;font-weight:700;letter-spacing:-.02em;
font-variant-numeric:tabular-nums}
.tbox{margin-top:14px;background:var(--ink-2);border-radius:14px;overflow:hidden;text-align:left;
box-shadow:inset 0 0 0 1px rgba(246,241,231,.06)}
.trow{display:flex;align-items:center;justify-content:space-between;gap:14px;
padding:13px 16px;border-top:1px solid rgba(246,241,231,.07)}
.trow:first-child{border-top:0}
.trow.wide{display:block}
.tk{color:rgba(246,241,231,.5);font-size:13px;flex:none}
.tv{font-weight:600;text-align:right;color:var(--cream);min-width:0;font-size:14.5px}
.trow.wide .tv{text-align:left;margin-top:5px}
.tv .acct{font-family:var(--display);font-variant-numeric:tabular-nums;letter-spacing:.03em;
font-size:20px;font-weight:700;line-height:1.2}
button.tcopy{height:52px;margin-top:14px}
button.icopy{flex:none;display:grid;place-items:center;width:34px;height:34px;margin:-6px -6px -6px 0;
border:0;border-radius:10px;background:transparent;color:rgba(246,241,231,.55);cursor:pointer;
-webkit-tap-highlight-color:transparent}
button.icopy:hover,button.icopy:focus-visible{background:rgba(246,241,231,.08);color:var(--cream)}
button.icopy:active{transform:scale(.94)}
button.icopy svg{width:17px;height:17px;display:block;fill:none;stroke:currentColor;
stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
button.icopy .i-yes{display:none}
button.icopy.done{color:#6fdc9c}
button.icopy.done .i-no{display:none}
button.icopy.done .i-yes{display:block}
.trow .tv{display:flex;align-items:center;justify-content:flex-end;gap:8px}
button.tcopy.done{background:var(--moss);color:var(--cream)}
.tfine{margin:14px 6px 0;font-size:13px;line-height:1.6;color:var(--ink-65);text-align:center}
.tfine strong{color:var(--ink);font-weight:600}
.twait{margin-top:16px;font-size:13px;color:rgba(246,241,231,.6);text-align:center;line-height:1.7}
.twait .dot{display:inline-block;vertical-align:baseline;width:7px;height:7px;
border-radius:50%;background:var(--marigold);margin-right:8px;animation:pulse 1.8s ease-in-out infinite}
.twait .tleft{color:rgba(246,241,231,.45)}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.twait .dot,.modal:target,.modal:target .msheet{animation:none}}
.tussd{margin-top:12px;text-align:center;font-size:13.5px;color:var(--ink-65)}
/* The page for when there is nothing to show: one card, centred. */
.sheet{max-width:520px;margin:-120px auto 0;padding:0 16px;position:relative}
.sheet .top{background:var(--paper);border-radius:20px;box-shadow:var(--lift);padding:28px}
.sheet h1{font-size:36px}
@media(max-width:520px){
  .band{height:184px}
  .shell{margin-top:-150px;padding:0 10px;gap:12px}
  .summary{padding:22px 20px 18px}
  h1{font-size:40px}
  .sect{padding-left:20px;padding-right:20px}
  th{padding:10px 20px}
  td{padding:14px 20px}
  .totals{margin:0 20px}
  .note{margin:0 20px 20px}
  .tcard{padding:20px 14px 16px}
  .trow{padding:12px 13px}
  .tv .acct{font-size:18px;letter-spacing:.02em}
  .sheet{padding:0 10px}
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


const LABEL: Record<PublicDocument["type"], string> = {
  invoice: "Invoice",
  quote: "Quote",
  payment_request: "Payment request",
  sample: "Sample",
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
/**
 * The agreed price, what it comes to in naira, and at what rate.
 *
 * Said in the step between "Continue to payment" and the card, since 26
 * September 2026, rather than under the headline: the page is about the
 * price that was agreed, and the naira only matters to somebody about to pay.
 * The rate is the one this invoice was priced at, worked back from its own
 * two figures, so it always agrees with them.
 */
function conversionStep(doc: PublicDocument, amountKobo: number): string {
  if (!doc.foreign) return "";
  const agreed = agreedTotalMinor(doc.foreign.amountMinor, doc.subtotalKobo, doc.vatKobo);
  const symbol = formatMoney(100, doc.foreign.currency).replace(/[\d.,]/g, "");
  const perUnit = agreed > 0 ? doc.totalKobo / agreed : doc.foreign.rate;
  const rate = `₦${perUnit.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const whole = amountKobo === doc.totalKobo;
  return `<div class="mrows">
      ${whole ? `<div class="row"><span>${esc(LABEL[doc.type])} total</span><b>${formatMoney(agreed, doc.foreign.currency)}</b></div>` : ""}
      <div class="row"><span>Rate</span><b>${symbol}1 = ${rate}</b></div>
      <div class="row"><span>You pay</span><b>${formatNaira(amountKobo)}</b></div>
    </div>`;
}

/**
 * A figure on the totals block: the agreed currency while nothing has been
 * paid, naira once anything has (see the note on the totals below).
 */
function agreedTotals(doc: PublicDocument): { subtotal: string; vat: string; total: string } | null {
  if (!doc.foreign || doc.amountPaidKobo > 0) return null;
  const c = doc.foreign.currency;
  const total = agreedTotalMinor(doc.foreign.amountMinor, doc.subtotalKobo, doc.vatKobo);
  return {
    subtotal: formatMoney(doc.foreign.amountMinor, c),
    vat: formatMoney(total - doc.foreign.amountMinor, c),
    total: formatMoney(total, c),
  };
}

function renderDocumentPage(
  doc: PublicDocument,
  today: Civil,
  opts: {
    token: string;
    error?: PayError;
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

  // An invoice priced abroad totals in what was agreed; see `agreedTotals`.
  const agreed = agreedTotals(doc);

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
<title>${label} ${clientNumber(doc.ref, doc.number) ?? ""} from ${esc(doc.businessName)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="${label} for ${esc(formatNaira(doc.totalKobo))} from ${esc(doc.businessName)}.">
<style>${CSS}</style>
</head><body>
<div class="band" aria-hidden="true"></div>
<main class="shell">
  <section class="card summary">
    <div class="ident">
      <div class="brand">${
        // The real logo where we have it; the wordmark in text if the asset is
        // missing, because a payment page must render either way. Inside the
        // card rather than on the band: a dark logo on a dark band vanishes.
        whose(doc)
      }</div>
      <div class="kind">${label} ${clientNumber(doc.ref, doc.number) ?? ""}</div>
    </div>
    ${doc.title ? `<div class="doctitle">${esc(doc.title)}</div>` : ""}
    <p class="eyebrow">${headlineLabel(doc)}</p>
    <h1>${doc.foreign ? formatMoney(agreedTotalMinor(doc.foreign.amountMinor, doc.subtotalKobo, doc.vatKobo), doc.foreign.currency) : formatNaira(doc.totalKobo)}</h1>
    ${statusPill(doc, today, overdue)}
    <dl class="facts">
      <div><dt>${doc.type === "quote" ? "For" : "Billed to"}</dt><dd>${esc(doc.clientName)}</dd></div>
      <div><dt>From</dt><dd>${esc(doc.businessName)}</dd></div>
      ${doc.issueDate ? `<div><dt>Issued</dt><dd>${esc(formatFriendly(doc.issueDate, today))}</dd></div>` : ""}
      ${
        doc.dueDate && doc.status !== "paid" && doc.status !== "cancelled"
          ? `<div><dt>${doc.type === "quote" ? "Valid until" : "Due"}</dt><dd>${esc(formatFriendly(doc.dueDate, today))}</dd></div>`
          : ""
      }
    </dl>
    ${partsBlock(doc, today)}
  </section>


  <section class="card items">
    <p class="sect"><span>What it is for</span><span>${doc.lines.length} item${doc.lines.length === 1 ? "" : "s"}</span></p>
    <table>
      <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totals">
      ${
        doc.vatKobo > 0
          ? `<div class="row"><span>Subtotal</span><span>${agreed?.subtotal ?? formatNaira(doc.subtotalKobo)}</span></div>
             <div class="row"><span>VAT</span><span>${agreed?.vat ?? formatNaira(doc.vatKobo)}</span></div>`
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
          : `<div class="row grand"><span>Total</span><span>${agreed?.total ?? formatNaira(doc.totalKobo)}</span></div>`
      }
    </div>
    ${doc.notes ? `<div class="note">${esc(doc.notes)}</div>` : ""}
  </section>

  <aside class="side">
    ${payBlock(doc, can, payableNowKobo(doc), opts, payableLabel(doc))}
    ${trustBlock(doc)}
    <div class="files">
      ${
        // F8: a payment request is "a lightweight payable with no PDF". There is
        // nothing itemised to render, and offering one implies there is.
        doc.type === "payment_request"
          ? ""
          : `<a href="${opts.base ?? "/i"}/${esc(opts.token)}/pdf">${DOWNLOAD}Download ${label.toLowerCase()} (PDF)</a>`
      }
      ${
        doc.amountPaidKobo > 0
          ? `<a href="/i/${esc(opts.token)}/receipt">${DOWNLOAD}Download receipt</a>`
          : ""
      }
    </div>
  </aside>
</main>
${doc.plan === "pro" ? "" : footer(doc)}
${doc.bank && can.ok === false ? `<script>${COPY_JS}</script>` : ""}
</body></html>`;
}

/** The page, in the business's colour when they are on Pro and have one. */
export function renderDocument(...args: Parameters<typeof renderDocumentPage>): string {
  const html = renderDocumentPage(...args);
  const doc = args[0];
  if (doc.plan !== "pro") return html;
  // The band across the top wears their colour too: it is the first thing
  // on the page, and on Pro the page is theirs.
  const k = brandTokens(doc.brandColor);
  const band = k ? html.replace("</head>", `<style>.band{background:${k.c}}</style></head>`) : html;
  return applyBrand(band, doc.brandColor);
}

/** The word over the headline figure: what it is, as the client reads it. */
function headlineLabel(doc: PublicDocument): string {
  if (doc.status === "cancelled") return "Cancelled";
  if (doc.type === "quote") return "Quoted";
  if (doc.status === "paid" || outstandingKobo(doc) === 0) return "Paid";
  return doc.amountPaidKobo > 0 ? "Total, part paid" : "Amount due";
}

/** A padlock, beside the line that says where a card payment goes. */
const LOCK = `<svg class="lock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" stroke="currentColor" stroke-width="1.5"/></svg>`;

/** A small arrow into a tray, on the download links. */
const DOWNLOAD = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Whose page this is, at the top.
 *
 * Free: ours, the Balans wordmark. Pro: theirs — their logo if they have one,
 * their name in our display face if not — because on Pro the invoice is the
 * business's own and the client should see nothing of the tool behind it.
 */
function whose(doc: PublicDocument): string {
  if (doc.plan === "pro") {
    return doc.logoDataUri
      ? `<img class="own-logo" src="${doc.logoDataUri}" alt="${esc(doc.businessName)}">`
      : `<span class="own-name">${esc(doc.businessName)}</span>`;
  }
  return logoAvailable() ? logoSvg("40px") : `<span class="dot"></span>balans`;
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
    cardReady?: boolean;
  },
  partLabel: string | null,
): string {
  if (can.ok) {
    // Paid to the sender's own details: those, and no button of ours.
    if (doc.paymentDetails) return ownDetailsBlock(doc, amount, partLabel);

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

    /*
     * Abroad, one step between the page and the card, since 26 September
     * 2026. The page talks in the price that was agreed ("Total $500.00"),
     * and a button saying "Pay ₦664,480" under it read as a different bill.
     * So the button says where it goes, and the step it opens says what the
     * card will actually be charged, in naira, at what rate, before anything
     * is charged.
     */
    if (doc.foreign) {
      return `<div class="pay card paycard">
    ${opts.error ? `<p class="banner cancelled" style="margin:0 0 14px;box-shadow:none;background:var(--cream)">${esc(opts.error.text)}</p>` : ""}
    <a class="pay-btn" href="#confirm">Continue to payment</a>
    <p class="secure">${LOCK}Paid by card to ${esc(doc.businessName)}. Takes about a minute.</p>
  </div>
  <div class="modal" id="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <div class="msheet">
      <h2 id="confirm-title">You pay in naira</h2>
      <p>${(() => {
        /*
         * Both ways the amount on their statement can differ from the price,
         * said before they pay: their bank converting the naira, or the
         * checkout offering to charge in their currency at its own rate
         * (a $1 test on 3 October 2026 came to $1.03 that way). Named in the
         * invoice's own money, because that is the number they agreed to.
         */
        const agreed = formatMoney(agreedTotalMinor(doc.foreign!.amountMinor, doc.subtotalKobo, doc.vatKobo), doc.foreign!.currency);
        return `Your card is charged in naira. Your bank converts it, or the payment page can charge it in ${esc(
          INFO[doc.foreign!.currency].many,
        )} at its own rate, so your statement may show a little more than ${esc(agreed)}, usually by a few percent.`;
      })()}</p>
      ${conversionStep(doc, amount)}
      <form method="post" action="/i/${esc(opts.token)}/pay">
        ${
          /*
           * Where the receipt goes, asked here because nowhere later can.
           *
           * Paystack's checkout takes the email it is given when the payment
           * starts and offers no box for one, so a client whose sender left
           * the email out was paying with nowhere for the receipt to go. Only
           * asked when there is none on file — somebody already known is not
           * made to type it again.
           */
          doc.clientHasEmail
            ? ""
            : `<label class="mfield" for="receipt-email">Email for your receipt
          <input id="receipt-email" name="email" type="email" inputmode="email" autocomplete="email"
            required maxlength="254" placeholder="you@company.com">
        </label>`
        }
        <button class="pay-btn" type="submit">Pay ${formatNaira(amount)} by card${
          partLabel ? ` &middot; ${esc(partLabel)}` : ""
        }</button>
      </form>
      <a class="mclose" href="#">Cancel</a>
    </div>
  </div>`;
    }

    // Unreachable: `payable` sends a naira invoice with no account to the
    // default below. Said the same way, in case that ever changes.
    return `<div class="banner cancelled">Ask ${esc(doc.businessName)} for their bank details to pay this ${LABEL[
      doc.type
    ].toLowerCase()}.</div>`;
  }

  switch (can.why) {
    case "bank_details":
      return bankBlock(doc, amount, partLabel);
    case "paid":
      return `<div class="banner paid">Paid in full. Nothing more to do.</div>${doc.plan === "pro" ? "" : tryBalans()}`;
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
      // No account to pay into: say something true without explaining our
      // plumbing to the client.
      return doc.foreign
        ? `<div class="banner cancelled">Online payment is not set up for this ${LABEL[doc.type].toLowerCase()} yet. Contact ${esc(doc.businessName)} to arrange payment.</div>`
        : `<div class="banner cancelled">Ask ${esc(doc.businessName)} for their bank details to pay this ${LABEL[doc.type].toLowerCase()}.</div>`;
  }
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
/**
 * How to pay, when the sender gave their own details (PayPal, Wise, a bank
 * abroad). Balans takes no part in this payment and cannot see it, so the
 * page says so, and that the sender confirms it.
 */
function ownDetailsBlock(doc: PublicDocument, amount: number, partLabel: string | null): string {
  const agreed = doc.foreign
    ? formatMoney(
        doc.amountPaidKobo === 0 && amount === doc.totalKobo
          ? agreedTotalMinor(doc.foreign.amountMinor, doc.subtotalKobo, doc.vatKobo)
          : Math.round(amount / (doc.foreign.rate || 1)),
        doc.foreign.currency,
      )
    : formatNaira(amount);
  return `<div class="pay own">
    <p class="teyebrow">How to pay${partLabel ? ` · ${esc(partLabel)}` : ""}</p>
    <p class="own-amt">${esc(agreed)} to ${esc(doc.businessName)}</p>
    <div class="own-details">${esc(doc.paymentDetails ?? "").replace(/\n/g, "<br>")}</div>
    <p class="tsmall">Pay ${esc(doc.businessName)} directly using the details above, and put
      ${esc(clientNumber(doc.ref, doc.number) ? `invoice ${clientNumber(doc.ref, doc.number)}` : "the invoice number")} in the reference.
      ${esc(doc.businessName)} will confirm when it arrives.</p>
  </div>`;
}

/**
 * Under "Paid in full", for a Free sender's client (9 October 2026): the
 * moment somebody has just seen an invoice paid this way is the moment the
 * idea lands. On the page, not by WhatsApp — a message they never asked for
 * would be marketing, and reported as it. Never under a Pro sender's invoice,
 * which is sold as theirs alone.
 */
function tryBalans(): string {
  const site = env.SITE_URL.replace(/\/$/, "");
  return `<a class="trybalans" href="${site}/?utm_source=paid_invoice&amp;utm_medium=invoice_page" target="_blank" rel="noopener">
    Get paid like this. Send invoices on WhatsApp in seconds. <b>Try Balans free &rarr;</b></a>`;
}

function trustBlock(doc: PublicDocument): string {
  if (doc.paymentDetails) return "";
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
  // Naira is never a card of ours: paid straight to the sender's bank, or a
  // quote that becomes such an invoice. Monnify was retired on 3 October 2026.
  if (!doc.foreign) {
    if (doc.type === "quote") {
      return `<div class="trust">
    <p class="tsmall">${doc.plan === "pro" ? "" : "Balans is not a bank and does not hold your money. "}If you accept, the invoice is paid straight
      to the bank account of <b>${esc(doc.businessName)}</b>.</p>
  </div>`;
    }
    return `<div class="trust">
    <p class="tsmall">${doc.plan === "pro" ? "" : "Balans is not a bank and does not hold your money. "}This invoice is paid straight
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
          : `${processor === "paystack" ? PAYSTACK_MARK : ""}<b>${processorName}</b>`
      }
    </span>
    <p class="tsmall">
      ${doc.plan === "pro" ? "" : "Balans is not a bank and does not hold your money."}${
        open
          ? ` If you accept this quote, payment settles directly to the bank account of <b>${esc(doc.businessName)}</b>.`
          : quote
            ? ` Payments to <b>${esc(doc.businessName)}</b> settle directly to their own bank account.`
            : ` This payment settles directly to the bank account of <b>${esc(doc.businessName)}</b>.`
      }
    </p>
  </div>`;
}

/**
 * Paystack's mark, drawn from their own artwork: four bars, the last short.
 * Inline for the same reason as every other mark on this page.
 */
const PAYSTACK_MARK = `<svg class="psmark" viewBox="0 0 422 413" aria-hidden="true"><g fill="#0AA5DB">
<rect width="399" height="84" rx="24"/><rect y="110" width="422" height="84" rx="24"/>
<rect y="220" width="399" height="83" rx="24"/><rect y="329" width="244" height="84" rx="24"/></g></svg>`;

/**
 * The line under every page, and the one place Balans asks for anything.
 *
 * Whoever receives an invoice is very often somebody who sends them too: the
 * event planner paying a photographer bills her own clients. So the page
 * says, once and quietly, what made it and where to get it, under everything
 * the client came for. The link is tagged so the site can tell these visits
 * from the rest.
 */
function footer(doc: PublicDocument): string {
  const site = env.SITE_URL.replace(/\/$/, "");
  const verb = doc.type === "quote" ? "Quoted" : doc.type === "payment_request" ? "Requested" : "Billed";
  return `<p class="foot">${markSvg("16px")}<span>${verb} with <b>Balans</b> on WhatsApp. <a href="${esc(
    `${site}/?utm_source=${doc.type}&utm_medium=page_footer`,
  )}">Send your own invoices in seconds</a></span></p>`;
}

/**
 * When Paystack would not open a checkout for Pro. Says what to do, and that
 * nothing was taken, since nothing can have been.
 */
export function renderProUnavailable(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Try again in a minute</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body>
<div class="band" aria-hidden="true"></div>
<div class="sheet"><div class="top">
  <div class="brand">${logoAvailable() ? logoSvg("28px") : `<span class="dot"></span>balans`}</div>
  <h1 style="margin-top:22px">Try again in a minute</h1>
  <p class="from">The payment page did not open just now. Nothing was charged. Go back to WhatsApp and tap Pay again.</p>
</div></div>
</body></html>`;
}

/** A 404 that does not confirm whether the token was ever real. */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>Not found</title><meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body>
<div class="band" aria-hidden="true"></div>
<div class="sheet"><div class="top">
  <div class="brand">${logoAvailable() ? logoSvg("28px") : `<span class="dot"></span>balans`}</div>
  <h1 style="margin-top:22px">Nothing here</h1>
  <p class="from">This link has expired, or it was never quite right. Ask whoever sent it for a new one.</p>
</div></div>
<p class="foot">${markSvg("16px")}<a href="https://balans.ng">balans.ng</a></p>
</body></html>`;
}

const compare = (a: Civil, b: Civil): number =>
  Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
