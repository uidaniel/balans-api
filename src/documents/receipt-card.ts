/**
 * The draft, as a receipt.
 *
 * The draft summary is the one message in this product somebody reads with
 * their guard up: it is the last thing between a number they typed and an
 * invoice their client sees. It had grown into a stack of labelled rows with
 * a "PS:" bolted on the end for the fees — correct, and shaped like a form
 * rather than like money.
 *
 * So the same facts are drawn instead, in the shape the landing page already
 * uses to explain where the money goes: a paper receipt, torn along the
 * bottom, with the fees itemised rather than summarised. Nothing new is being
 * said. It is the arithmetic `payout` already did, laid out so the eye lands
 * on "To your bank" instead of on the invoice total.
 *
 * Deliberately not a copy of that landing-page component. The plan tabs and
 * the amount chips there are controls for somebody deciding whether to sign
 * up; this reader has signed up, typed an amount and is about to send it, so
 * the only interactive thing left is the three buttons underneath.
 *
 * WHAT THIS IS NOT ALLOWED TO DO: replace the words. A picture cannot be
 * searched in a chat, copied, or read aloud, and Chrome can fail. Every
 * caller keeps the text summary as the body of the message and falls back to
 * it whole if the render does not come back. See `draftCard`.
 */

import type { FastifyBaseLogger } from "fastify";

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { logoAvailable, logoSvg } from "../brand/logo.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng } from "../pdf/chrome.ts";
import { uploadDocument } from "../whatsapp/client.ts";
import { formatNaira } from "../../core/totals.ts";
import { formatMoney, INFO } from "../../core/currency.ts";
import { agreedTotalMinor } from "../../core/exchange.ts";
import { defaults } from "../config.ts";
import { settlesLine } from "../payments/settlement.ts";
import { payout, planLines } from "./summary.ts";
import type { Draft } from "./store.ts";

/**
 * Square, and large.
 *
 * WhatsApp shows the header of an interactive message at a width it chooses
 * and scales to fit, so the safe shape is the one that survives both a narrow
 * phone and a tablet. The Pro card is 2160 for the same reason: rendering
 * once at a size nothing has to upscale is cheaper than being blurry on one
 * device in ten.
 */
export const CARD = 1400;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A row with a dotted leader, as on a printed bill.
 *
 * `cost` sets the figure in red: money leaving the amount on its way to the
 * bank. Only the figure, so the label stays as quiet as the rest of the list
 * and the eye goes straight to what is being taken.
 */
const row = (
  label: string,
  value: string,
  opts: { muted?: boolean; strong?: boolean; cost?: boolean } = {},
): string =>
  `<div class="row${opts.muted ? " muted" : ""}${opts.strong ? " strong" : ""}">
     <span class="l">${esc(label)}</span><span class="lead"></span><span class="v${opts.cost ? " cost" : ""}">${esc(value)}</span>
   </div>`;

/** An item: its name, a chip with how many, a leader and the figure. */
const itemRow = (name: string, qty: number, value: string): string =>
  `<div class="row item">
     <span class="l">${esc(name)}</span><span class="q">× ${esc(String(qty))}</span><span class="lead"></span><span class="v">${esc(value)}</span>
   </div>`;

/** Up to two initials, for the client's mark beside their name. */
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "·";

/** A bank, drawn: for the line that says the money lands there. */
const BANK = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5 12 4l9 5.5H3ZM5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18"/></svg>`;
/** A calendar, for the date it is due. */
const CAL = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;
/** A clock, for when the money arrives. */
const CLOCK = `<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;

/** Two arrows passing, for "this converts to that". Drawn, not a font glyph. */
const SWAP = `<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="#10231c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/></svg>`;

export function receiptHtml(draft: Draft, plan: "free" | "pro", today: Civil): string {
  const money = payout(draft, plan);
  const quote = draft.type === "quote";

  const line =
    draft.lines.length === 1
      ? (draft.lines[0]?.description ?? "")
      : `${draft.lines.length} items`;

  /*
   * The plan's stages, if there are any.
   *
   * Reused rather than re-derived: `planLines` is what the words say and what
   * the stored parts agree with, so the picture cannot drift from either. The
   * "Payment plan:" heading it puts first is dropped — the card has its own.
   */
  const stages = planLines(draft, today).slice(1).map((s) => s.replace(/^\s*[-·]\s*/, ""));

  /*
   * The items, each with its quantity — 1 included, because a card that says
   * "× 2" on one line and nothing on the next reads as a field left blank.
   * In what was agreed: dollars on a dollar invoice, as the client will see.
   *
   * Three at most, two on a busy card. The card is a fixed square read on a phone, and a fourth
   * row pushes the total and the settlement line off it; the rest are named
   * as a count, and the PDF carries every one.
   */
  // Fewer when the card already carries more: the dollar pair and fee rows,
  // a VAT line, a payment plan. Measured: dollars with VAT and two items
  // left three pixels to spare on the 1400px square.
  const busy = [Boolean(draft.foreign), draft.vatKobo > 0, stages.length > 0].filter(Boolean).length;
  const SHOWN = busy >= 2 ? 1 : busy === 1 ? 2 : 3;
  const itemAmount = (l: Draft["lines"][number]) =>
    draft.foreign && l.originalUnitAmountMinor !== undefined
      ? formatMoney(l.originalUnitAmountMinor * l.qty, draft.foreign.currency)
      : formatNaira(l.unitAmountKobo * l.qty);
  const itemRows = draft.lines.length
    ? `<div class="rows items">
      ${draft.lines
        .slice(0, SHOWN)
        .map((l) => itemRow(l.description, l.qty, itemAmount(l)))
        .join("")}
      ${draft.lines.length > SHOWN ? `<div class="more">+ ${draft.lines.length - SHOWN} more on the invoice</div>` : ""}
    </div>`
    : "";

  /*
   * Only when the client is paying the processor's cut, because only then is
   * it a different number from the invoice. Showing "Client pays ₦20,000"
   * above "Invoice amount ₦20,000" is the same figure twice.
   */
  const grossedUp = money.clientPaysKobo !== draft.totalKobo;

  /*
   * Monnify charges per payment, so a split invoice pays their fee twice.
   *
   * Unlabelled, that reads as a broken promise: their cut is capped at ₦2,000
   * and a ₦200,000 invoice split in two shows ₦2,700. Both numbers are right
   * — two transfers are two charges, each capped on its own — but nothing on
   * the card said which. Our own fee needs no such note, because it is capped
   * across the invoice however many payments it arrives in.
   */
  /*
   * And which processor is charging it (International PRD section 9).
   *
   * `payout` already works this out — a foreign price is an international
   * card at 3.9% + ₦100, not a transfer capped at ₦2,000 — so the figure on
   * this card was right while the word beside it was wrong. Naming the wrong
   * company next to a correct number is worse than saying nothing: it is the
   * line somebody checks their bank statement against.
   */
  const processor = "Paystack";
  const processorLabel =
    stages.length > 1 ? `${processor} fee (${stages.length} payments)` : `${processor} fee`;

  /*
   * A naira invoice is paid by transfer straight to the sender's own account
   * (see bank-details.ts). No processor touches it and there is no fee to
   * itemise, so the card says the one thing that is true: all of it lands.
   */
  /*
   * Paid by card through Paystack: a foreign invoice, unless the sender chose
   * their own bank or their own details for it (7 October 2026), when no
   * processor touches the money and there is no fee to show.
   */
  const card = Boolean(draft.foreign) && draft.payBy !== "own" && draft.payBy !== "bank";
  const feeRows = card
    ? `
    <div class="rows">
      ${grossedUp ? row("Client pays", formatNaira(money.clientPaysKobo)) : ""}
      ${row(processorLabel, `−${formatNaira(money.processorFeeKobo)}`, { muted: true, cost: true })}
      ${
        money.balansFeeKobo > 0
          ? row(`Balans fee (${plan === "pro" ? "Pro" : "Free"})`, `−${formatNaira(money.balansFeeKobo)}`, {
              muted: true,
              cost: true,
            })
          : row("Balans fee (Pro)", "₦0", { muted: true })
      }
    </div>
    <div class="total"><span class="ic">${BANK}</span>${row("To your bank", formatNaira(money.receivesKobo), { strong: true })}</div>

`
    : `<div class="rows">
      ${row("Fees", "₦0", { muted: true })}
    </div>
    <div class="total"><span class="ic">${BANK}</span>${row("To your bank", formatNaira(draft.totalKobo), { strong: true })}</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* The faces travel with the render. A PNG is drawn from HTML with no
     origin and no network, so a linked stylesheet would simply not resolve
     and the card would come back in whatever the container happens to have —
     which, in this image, is DejaVu. */
  ${fontFaces(["display"])}
  :root {
    --ink:#10231c; --ink2:#173128; --cream:#f6f1e7; --sand:#e9e1d0; --sand-2:#ddd3bf; --moss:#2e8a55; --red:#d14343;
    --marigold:#f5b82e; --soft:#f6f2ea;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${CARD}px; height:${CARD}px; overflow:hidden; }
  body {
    background:var(--cream);
    color:var(--ink);
    font-family:${FONT.display};
    font-size:34px; line-height:1.4;
    display:flex; align-items:center; justify-content:center; padding:50px;
  }

  /* The torn edge, exactly as the site draws it: a conic-gradient mask cut
     into teeth. Chrome renders it; nothing here is an image of a zigzag. */
  .paper {
    --tooth:34px;
    width:100%; background:#fff; padding:50px 58px calc(var(--tooth) + 46px);
    border-radius:34px 34px 0 0;
    box-shadow:0 26px 60px -40px rgb(16 35 28 / 0.45);
    mask: conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg)
          50% / var(--tooth) 100%;
  }

  /* The logo is inlined as SVG markup rather than linked, so it cannot be a
     request that fails mid-render. If the asset is missing the wordmark is
     set in type instead. */
  .head { display:flex; align-items:center; justify-content:space-between; gap:24px; }
  .mark { display:flex; }
  .mark svg { height:58px; width:auto; display:block; }
  .mark .word { font-size:42px; font-weight:800; letter-spacing:-0.03em; }
  .mark .word i { font-style:normal; color:var(--moss); }
  .tag { padding:10px 22px; border-radius:999px; background:var(--soft); font-size:26px; font-weight:700;
         letter-spacing:0.06em; text-transform:uppercase; color:rgb(16 35 28 / 0.62); white-space:nowrap; }

  h1 { margin-top:34px; font-size:52px; font-weight:800; letter-spacing:-0.035em; line-height:1.1; }
  .sub { margin-top:14px; display:flex; align-items:center; gap:16px; font-size:30px; color:rgb(16 35 28 / 0.6); min-width:0; }
  .sub .av { width:52px; height:52px; border-radius:50%; flex:none; display:grid; place-items:center;
             background:var(--ink); color:var(--cream); font-size:22px; font-weight:800; letter-spacing:0; }
  .sub span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sub b { color:var(--ink); font-weight:700; }

  /* The amount, on a panel of its own. */
  .band { margin-top:30px; padding:30px 34px; border-radius:28px; background:var(--soft); }
  .cap { font-size:27px; color:rgb(16 35 28 / 0.55); }
  .amount { margin-top:2px; font-size:88px; font-weight:800; letter-spacing:-0.045em; line-height:1.05; }
  .pair { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:24px; }
  .pair .amount { font-size:64px; white-space:nowrap; }
  .pair .r { text-align:right; }
  .amount.naira { color:var(--moss); }
  .swap { width:92px; height:92px; border-radius:50%; background:var(--marigold);
          display:grid; place-items:center; }
  .rate { margin:18px auto 0; display:table; padding:10px 22px; border-radius:999px;
          background:#fff; font-size:30px; font-weight:700; letter-spacing:-0.01em; }
  .meta { margin-top:18px; display:flex; flex-wrap:wrap; gap:12px; }
  .when { display:inline-flex; align-items:center; gap:10px; padding:10px 20px 10px 16px; border-radius:999px;
          background:#fff; font-size:27px; font-weight:600; color:var(--ink); }
  .when svg { color:var(--moss); }
  .stages { margin-top:18px; display:grid; gap:10px; font-size:27px; color:rgb(16 35 28 / 0.7); }
  .stages div { display:flex; align-items:center; gap:14px; }
  .stages div::before { content:""; width:14px; height:14px; border-radius:50%; background:var(--marigold); flex:none; }

  .rows { margin-top:28px; }
  .row { display:flex; align-items:baseline; gap:14px; margin-top:14px; }
  .row .lead { flex:1; min-width:24px; border-bottom:3px dotted currentColor;
               opacity:0.25; transform:translateY(-0.3em); }
  .row.muted { color:rgb(16 35 28 / 0.55); }
  .row .v { font-weight:600; white-space:nowrap; }
  .row .v.cost { color:var(--red); font-weight:700; }
  .items { margin-top:30px; font-size:30px; }
  .items .row { margin-top:12px; }
  .items .l { max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .items .q { flex:none; align-self:center; padding:3px 12px; border-radius:999px; background:var(--soft);
              font-size:23px; font-weight:700; color:rgb(16 35 28 / 0.6); }
  .items .more { margin-top:10px; font-size:25px; color:rgb(16 35 28 / 0.5); }

  /* What lands, in the colour of money that has arrived. */
  .total { margin-top:24px; display:flex; align-items:center; gap:22px; padding:24px 28px; border-radius:24px;
           background:rgb(46 138 85 / 0.1); color:var(--moss); }
  .total .ic { width:72px; height:72px; border-radius:20px; flex:none; display:grid; place-items:center;
               background:var(--moss); color:#fff; }
  .total .row { flex:1; margin:0; color:var(--ink); }
  .total .row .lead { display:none; }
  .total .row .l { flex:1; }
  .row.strong { font-size:40px; font-weight:800; letter-spacing:-0.02em; }
  .row.strong .v { font-size:46px; font-weight:800; color:var(--moss); letter-spacing:-0.03em; }
  .note { margin-top:20px; font-size:26px; line-height:1.5; color:rgb(16 35 28 / 0.5); }
  /*
   * The settlement line is the footer of the card, not a footnote on it:
   * "when do I get the money" is the question the card exists to answer, so
   * it is said once, here, at a size that survives a phone in a chat thread.
   */
  .settles { margin-top:26px; display:flex; align-items:center; gap:22px; padding:24px 28px; border-radius:24px;
             background:rgb(245 184 46 / 0.16); color:var(--ink); font-size:32px; font-weight:700; line-height:1.3; }
  .settles .ic { width:64px; height:64px; border-radius:50%; flex:none; display:grid; place-items:center;
                 background:var(--marigold); color:var(--ink); }
  .settles span { display:block; margin-top:6px; font-size:24px; font-weight:500; color:rgb(16 35 28 / 0.62); }
</style></head>
<body>
  <div class="paper">
    <div class="head">
      <div class="mark">${
        logoAvailable() ? logoSvg("58px") : `<span class="word">bala<i>n</i>s</span>`
      }</div>
      <span class="tag">${quote ? "Quote" : "Invoice"}${draft.number ? ` · No. ${esc(String(draft.number))}` : ""}</span>
    </div>

    <h1>${quote ? "Quote" : "Invoice"} breakdown</h1>
    <p class="sub"><span class="av">${esc(initials(draft.clientName))}</span><span>For ${esc(draft.clientName)} · ${esc(draft.title || line)}</span></p>

    <div class="band">
      ${
        /*
         * Abroad: the agreed price and the naira it is charged as, side by
         * side, with the rate under them. They are one amount said twice, and
         * setting them apart with a sentence between ("₦927,892.70 charged,
         * at today's rate") made two facts out of it. The rate is the one the
         * draft was locked at, as stored.
         *
         * The agreed side includes VAT, because the naira side does: the
         * card used to set "$650.00" beside ₦927,892.70, which is $698.75.
         */
        draft.foreign
          ? `<div class="pair">
               <div class="side"><div class="cap">${quote ? "Quote" : "Invoice"} amount</div>
                 <div class="amount">${esc(formatMoney(agreedTotalMinor(draft.foreign.amountMinor, draft.subtotalKobo, draft.vatKobo), draft.foreign.currency))}</div></div>
               <div class="swap">${SWAP}</div>
               <div class="side r"><div class="cap">Naira amount</div>
                 <div class="amount naira">${formatNaira(draft.totalKobo)}</div></div>
             </div>
             <div class="rate">${INFO[draft.foreign.currency].symbol}1 → ${formatNaira(Math.round(draft.foreign.rate * 100))}</div>`
          : `<div class="cap">${quote ? "Quote" : "Invoice"} amount</div>
             <div class="amount">${formatNaira(draft.totalKobo)}</div>`
      }
      ${
        draft.vatKobo > 0 || draft.dueDate
          ? `<div class="meta">${
              draft.dueDate
                ? `<span class="when">${CAL}${quote ? "Valid until" : "Due"} ${esc(formatFriendly(draft.dueDate, today))}</span>`
                : ""
            }${draft.vatKobo > 0 ? `<span class="when">Includes ${esc(String(draft.vatPercent))}% VAT</span>` : ""}</div>`
          : ""
      }
      ${stages.length ? `<div class="stages">${stages.map((s) => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
    </div>

    ${itemRows}

    ${feeRows}

    <div class="settles"><span class="ic">${CLOCK}</span><div>${
      /*
       * Section 9, in as many words: never say "tonight" about a card.
       * Monnify's 10 PM run is a promise we can make because we know the hour
       * of it and because it runs every day. A card is on Paystack's schedule,
       * so the sentence comes from configuration — and `settlesLine` is the
       * one place either is decided, so no two surfaces can disagree about
       * when somebody is getting paid.
       *
       * Computed from the clock at render time, which is what makes "tonight"
       * honest: an invoice drawn up at 11 PM says tomorrow, because 22:00 has
       * already gone.
       */
      card
        ? esc(settlesLine(new Date(), "paystack"))
        : draft.payBy === "own"
          ? "Your client pays you directly"
          : "Your client pays straight into your bank account"
    }${
      card
        ? `<span>Paid by card</span>`
        : draft.payBy === "own"
          ? `<span>Using your payment details. Tell me once it lands and I will send the receipt.</span>`
          : `<span>By transfer. Tell me once it lands and I will send the receipt.</span>`
    }</div></div>
  </div>
</body></html>`;
}

/**
 * The card, rendered and uploaded, or null.
 *
 * Null is an ordinary outcome, not an error. Chrome is a subprocess on a
 * 2GB box that also renders PDFs, and Meta's upload is a network call — both
 * can fail, and neither is worth losing a draft over. Every caller treats
 * null as "send the words", which is exactly what this product did before
 * there was a card at all.
 *
 * Uploaded rather than hosted. The brand artwork is served from a URL because
 * it is public and Meta can cache it; this has a client's name and a figure
 * on it, and a URL for that is a public page for private money however
 * unguessable the path. An upload has no address, and the thirty-day expiry
 * that rules media ids out for brand files cannot matter to an image used
 * once, seconds after it is made.
 */
export async function draftCard(
  draft: Draft,
  plan: "free" | "pro",
  today: Civil,
  log: FastifyBaseLogger,
): Promise<string | null> {
  // A sample is a demonstration with nobody's money in it, and the card is
  // entirely about where money goes.
  if (draft.type === "sample") return null;

  const started = Date.now();
  try {
    const png = await renderPng(receiptHtml(draft, plan, today), CARD, CARD);
    const up = await uploadDocument(png, "draft.png", "image/png");

    if (!up.ok) {
      log.warn({ reason: up.reason }, "draft receipt could not be uploaded, sending the words");
      return null;
    }

    log.info({ ms: Date.now() - started, bytes: png.length }, "draft receipt drawn");
    return up.mediaId;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "draft receipt could not be drawn, sending the words");
    return null;
  }
}
