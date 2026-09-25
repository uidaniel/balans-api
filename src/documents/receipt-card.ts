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
  const processor = draft.foreign ? "Paystack" : "Monnify";
  const processorLabel =
    stages.length > 1 ? `${processor} fee (${stages.length} payments)` : `${processor} fee`;

  /*
   * A naira invoice is paid by transfer straight to the sender's own account
   * (see bank-details.ts). No processor touches it and there is no fee to
   * itemise, so the card says the one thing that is true: all of it lands.
   */
  const feeRows = draft.foreign
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
      <div class="total">${row("To your bank", formatNaira(money.receivesKobo), { strong: true })}</div>
    </div>

`
    : `<div class="rows">
      ${row("Fees", "₦0", { muted: true })}
      <div class="total">${row("To your bank", formatNaira(draft.totalKobo), { strong: true })}</div>
    </div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* The faces travel with the render. A PNG is drawn from HTML with no
     origin and no network, so a linked stylesheet would simply not resolve
     and the card would come back in whatever the container happens to have —
     which, in this image, is DejaVu. */
  ${fontFaces(["display"])}
  :root {
    --ink:#10231c; --cream:#f6f1e7; --sand:#e9e1d0; --sand-2:#ddd3bf; --moss:#2e8a55; --red:#d14343;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${CARD}px; height:${CARD}px; overflow:hidden; }
  body {
    background:var(--cream); color:var(--ink);
    font-family:${FONT.display};
    font-size:34px; line-height:1.45;
    display:flex; align-items:center; justify-content:center; padding:52px;
  }

  /* The torn edge, exactly as the site draws it: a conic-gradient mask cut
     into teeth. Chrome renders it; nothing here is an image of a zigzag. */
  .paper {
    --tooth:34px;
    width:100%; background:#fff; padding:62px 64px calc(var(--tooth) + 54px);
    mask: conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg)
          50% / var(--tooth) 100%;
    box-shadow:0 26px 60px -40px rgb(16 35 28 / 0.45);
  }

  /* The logo is inlined as SVG markup rather than linked, so it cannot be a
     request that fails mid-render. This only styles what is already there;
     if the asset is missing the wordmark is set in type instead. */
  .mark { display:flex; justify-content:center; margin-bottom:36px; }
  .mark svg { height:64px; width:auto; display:block; }
  .mark .word { font-size:44px; font-weight:800; letter-spacing:-0.03em; }
  .mark .word i { font-style:normal; color:var(--moss); }

  h1 { font-size:46px; font-weight:800; letter-spacing:-0.02em; text-align:center; }
  .sub { margin-top:10px; text-align:center; font-size:29px; color:rgb(16 35 28 / 0.5); }

  .band { margin-top:38px; padding:26px 0; border-top:2px dashed rgb(16 35 28 / 0.25);
          border-bottom:2px dashed rgb(16 35 28 / 0.25); }
  .cap { font-size:28px; color:rgb(16 35 28 / 0.55); }
  .amount { margin-top:4px; font-size:76px; font-weight:800; letter-spacing:-0.03em; }
  .pair { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:28px; }
  .pair .amount { font-size:62px; white-space:nowrap; }
  .pair .r { text-align:right; }
  .amount.naira { color:var(--moss); }
  .swap { width:96px; height:96px; border-radius:50%; background:#f5b82e;
          display:grid; place-items:center; }
  .rate { margin:22px auto 6px; display:table; padding:10px 22px; border-radius:999px;
          background:rgb(16 35 28 / 0.06); font-size:32px; font-weight:700; letter-spacing:-0.01em; }
  .when { margin-top:10px; font-size:29px; color:rgb(16 35 28 / 0.6); }

  .stages { margin-top:20px; font-size:28px; color:rgb(16 35 28 / 0.6); }
  .stages div { margin-top:6px; }

  .rows { margin-top:34px; }
  .row { display:flex; align-items:baseline; gap:14px; margin-top:16px; }
  .row .lead { flex:1; min-width:24px; border-bottom:3px dotted currentColor;
               opacity:0.3; transform:translateY(-0.3em); }
  .row.muted { color:rgb(16 35 28 / 0.55); }
  .row .v.cost { color:var(--red); font-weight:600; }
  .row.strong { margin-top:0; font-size:40px; font-weight:800; }

  .total { margin-top:26px; padding-top:24px; border-top:4px solid var(--ink); }
  .note { margin-top:20px; font-size:26px; line-height:1.5; color:rgb(16 35 28 / 0.5); }
  /*
   * The settlement line is the footer of the card, not a footnote on it.
   *
   * It used to be grey 26px under the total and repeated in the message text
   * below the picture. When somebody is deciding whether to send an invoice,
   * "when do I get the money" is the question the card exists to answer, so it
   * is said once, here, at a size that survives being looked at on a phone in
   * a chat thread.
   */
  .settles { margin-top:34px; padding:26px 30px; border-radius:20px;
             background:rgb(245 184 46 / 0.16); color:var(--ink);
             font-size:32px; font-weight:700; line-height:1.4; text-align:center; }
  .settles span { display:block; margin-top:8px; font-size:25px; font-weight:500;
                  color:rgb(16 35 28 / 0.62); }
</style></head>
<body>
  <div class="paper">
    <div class="mark">${
      logoAvailable() ? logoSvg("64px") : `<span class="word">bala<i>n</i>s</span>`
    }</div>

    <h1>${quote ? "Quote" : "Invoice"} breakdown</h1>
    <p class="sub">For ${esc(draft.clientName)} · ${esc(line)}</p>

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
      ${draft.vatKobo > 0 ? `<div class="when">Includes ${esc(String(draft.vatPercent))}% VAT</div>` : ""}
      ${
        draft.dueDate
          ? `<div class="when">${quote ? "Valid until" : "Due"} ${esc(formatFriendly(draft.dueDate, today))}</div>`
          : ""
      }
      ${stages.length ? `<div class="stages">${stages.map((s) => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
    </div>

    ${feeRows}

    <div class="settles">${
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
      draft.foreign
        ? esc(settlesLine(new Date(), "paystack"))
        : "Your client pays straight into your bank account"
    }${
      draft.foreign
        ? `<span>Paid by card</span>`
        : `<span>By transfer. Tell me once it lands and I will send the receipt.</span>`
    }</div>
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
