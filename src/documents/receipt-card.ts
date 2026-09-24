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
import { formatMoney } from "../../core/currency.ts";
import { defaults } from "../config.ts";
import { SETTLEMENT_HOUR } from "../payments/settlement.ts";
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

/** A row with a dotted leader, as on a printed bill. */
const row = (label: string, value: string, opts: { muted?: boolean; strong?: boolean } = {}): string =>
  `<div class="row${opts.muted ? " muted" : ""}${opts.strong ? " strong" : ""}">
     <span class="l">${esc(label)}</span><span class="lead"></span><span class="v">${esc(value)}</span>
   </div>`;

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
  const stages = planLines(draft, today).slice(1).map((s) => s.replace(/^\s*·\s*/, ""));

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

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* The faces travel with the render. A PNG is drawn from HTML with no
     origin and no network, so a linked stylesheet would simply not resolve
     and the card would come back in whatever the container happens to have —
     which, in this image, is DejaVu. */
  ${fontFaces(["display"])}
  :root {
    --ink:#10231c; --cream:#f6f1e7; --sand:#e9e1d0; --sand-2:#ddd3bf; --moss:#3f8f5f;
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
  .when { margin-top:10px; font-size:29px; color:rgb(16 35 28 / 0.6); }

  .stages { margin-top:20px; font-size:28px; color:rgb(16 35 28 / 0.6); }
  .stages div { margin-top:6px; }

  .rows { margin-top:34px; }
  .row { display:flex; align-items:baseline; gap:14px; margin-top:16px; }
  .row .lead { flex:1; min-width:24px; border-bottom:3px dotted currentColor;
               opacity:0.3; transform:translateY(-0.3em); }
  .row.muted { color:rgb(16 35 28 / 0.55); }
  .row.strong { margin-top:0; font-size:40px; font-weight:800; }

  .total { margin-top:26px; padding-top:24px; border-top:4px solid var(--ink); }
  .note { margin-top:20px; font-size:26px; line-height:1.5; color:rgb(16 35 28 / 0.5); }
</style></head>
<body>
  <div class="paper">
    <div class="mark">${
      logoAvailable() ? logoSvg("64px") : `<span class="word">bala<i>n</i>s</span>`
    }</div>

    <h1>${quote ? "Quote" : "Invoice"} Payment Breakdown</h1>
    <p class="sub">For ${esc(draft.clientName)} · ${esc(line)}</p>

    <div class="band">
      <div class="cap">${quote ? "Quote" : "Invoice"} amount</div>
      <div class="amount">${
        draft.foreign
          ? esc(formatMoney(draft.foreign.amountMinor, draft.foreign.currency))
          : formatNaira(draft.totalKobo)
      }</div>
      ${
        /*
         * The agreed price is the headline, and the naira charge sits under
         * it — the same rule the PDF follows, for the same reason: $150 is
         * what the two of them said yes to.
         *
         * It also has to match the words directly underneath, which say
         * "Amount: $150.00". A picture captioned "Invoice amount
         * ₦213,958.33" above a message saying $150.00 is two answers to one
         * question, in the one message this product asks people to check.
         */
        draft.foreign
          ? `<div class="when">${formatNaira(draft.totalKobo)} charged, at today’s rate</div>`
          : ""
      }
      ${
        draft.dueDate
          ? `<div class="when">${quote ? "Valid until" : "Due"} ${esc(formatFriendly(draft.dueDate, today))}</div>`
          : ""
      }
      ${stages.length ? `<div class="stages">${stages.map((s) => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
    </div>

    <div class="rows">
      ${grossedUp ? row("Client pays", formatNaira(money.clientPaysKobo)) : ""}
      ${row(processorLabel, `−${formatNaira(money.processorFeeKobo)}`, { muted: true })}
      ${
        money.balansFeeKobo > 0
          ? row(`Balans fee (${plan === "pro" ? "Pro" : "Free"})`, `−${formatNaira(money.balansFeeKobo)}`, {
              muted: true,
            })
          : row("Balans fee (Pro)", "₦0", { muted: true })
      }
      <div class="total">${row("To your bank", formatNaira(money.receivesKobo), { strong: true })}</div>
    </div>

    <p class="note">${
      draft.foreign
        ? /*
           * Section 9, in as many words: never say "tonight" about a card.
           * Monnify's 10 PM run is a promise we can make because we know the
           * hour of it. This is a card on somebody else’s schedule, so the
           * sentence comes from configuration — the same one the words under
           * the picture use, so the two cannot disagree.
           */
          `Paid by card. ${esc(defaults.international.settlementText)}`
        : `Settles at ${SETTLEMENT_HOUR > 12 ? SETTLEMENT_HOUR - 12 : SETTLEMENT_HOUR} PM the same day,
           straight from Monnify. Every day, including weekends.`
    }</p>
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
