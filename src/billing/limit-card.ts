/**
 * The limit card, drawn from the user's own invoice (20 October 2026).
 *
 * The stock card says "Three done. Go unlimited." to everybody. This one
 * shows the last invoice they sent on the trial, in their own design, with
 * their logo and colour, under "This is yours. Keep sending it." Somebody is
 * readier to pay to keep a thing they already have than to buy a feature
 * list, and by their fourth invoice the branded one is theirs.
 *
 * Drawn twice: the sheet as a picture, then the card around that picture. A
 * sheet is a full page of its own CSS, and putting it in the card's page
 * would have the two stylesheets fight over the same class names.
 *
 * Uploaded rather than served from a URL, like the draft card: it carries a
 * client's name and an amount. Null whenever anything fails, and the caller
 * sends the stock card instead, so a slow Chrome never costs the message.
 */

import type { FastifyBaseLogger } from "fastify";

import { artUri, naira } from "../brand/cards.ts";
import { defaults } from "../config.ts";
import { db } from "../db/pool.ts";
import { documentSheetHtml } from "../documents/pdf.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng, rendererAvailable } from "../pdf/chrome.ts";
import { uploadDocument } from "../whatsapp/client.ts";

export const LIMIT_W = 1080;
export const LIMIT_H = 1350;

/** A4 at 96 dpi: the size a sheet is laid out for. */
const SHEET_W = 794;
const SHEET_H = 1123;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * One card per user per invoice for a few hours. A user out of free
 * documents tends to try again straight away, and the picture would be the
 * same each time.
 */
const cache = new Map<string, { documentId: string; mediaId: string; at: number }>();
const KEEP_MS = 6 * 60 * 60 * 1000;

/** The newest document they sent on the trial, invoices first. */
async function lastTrialDocument(userId: string): Promise<string | null> {
  const { rows } = await db().query<{ id: string }>(
    `SELECT id FROM documents
      WHERE user_id = $1 AND trial AND type <> 'sample' AND status <> 'draft'
      ORDER BY (type = 'invoice') DESC, created_at DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export function limitCardHtml(sheetPng: Buffer, allowance: number): string {
  const { priceKobo, yearPriceKobo } = defaults.plans.pro;
  const n = WORDS[allowance] ?? String(allowance);
  // The art of the stock limit card (brand/cards.ts) at half size: night
  // green, the open padlock, gold satin rising at the foot. 2160 × 2700 is
  // exactly twice this card.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces(["brand"])}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${LIMIT_W}px;height:${LIMIT_H}px}
body{background:#08130f;color:#f6f1e7;font-family:${FONT.brand};position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.art{position:absolute;left:0;top:0;width:${LIMIT_W}px;display:block}
.logo{position:absolute;left:75px;top:75px;height:66px}
.pill{position:absolute;right:75px;top:79px;height:58px;padding:0 28px;border-radius:999px;background:#10231c;color:#f6f1e7;
box-shadow:inset 0 0 0 1.5px rgb(246 241 231/.14);font-weight:500;font-size:24px;display:flex;align-items:center}
h1{position:absolute;left:72px;top:200px;font-weight:400;font-size:92px;line-height:.98;letter-spacing:-.05em}
h1 span{display:block}h1 .m{color:rgb(246 241 231/.48)}
.sub{position:absolute;left:75px;top:410px;width:620px;font-size:30px;line-height:1.36;color:rgb(246 241 231/.66)}
.sheet{position:absolute;left:200px;top:650px;width:660px;transform:rotate(-3deg);transform-origin:top left;border-radius:18px;
overflow:hidden;box-shadow:0 40px 90px rgba(0,0,0,.55);background:#fff}
.sheet img{display:block;width:660px;height:auto}
.price{position:absolute;left:75px;right:75px;bottom:75px;height:250px;border-radius:40px;background:rgb(8 19 15/.88);
backdrop-filter:blur(40px) saturate(130%);box-shadow:inset 0 2px 0 rgb(255 240 200/.16),inset 0 0 0 1.5px rgb(246 241 231/.14);
display:flex;align-items:center;justify-content:space-between;padding:0 44px}
.amount{font-size:112px;font-weight:500;line-height:1;letter-spacing:-.055em}
.per{font-size:26px;color:rgb(246 241 231/.66);margin-top:10px}
.cta{height:66px;padding:0 34px;border-radius:999px;display:flex;align-items:center;font-weight:500;font-size:26px;color:#10231c;
background:linear-gradient(180deg,#ffd877,#f5b82e);box-shadow:inset 0 2px 0 rgb(255 250 230/.6)}
.ngn{position:relative;display:inline-block;line-height:1}
.ngn::before,.ngn::after{content:"";position:absolute;left:-.06em;right:-.06em;height:.065em;background:currentColor;top:.36em}
.ngn::after{top:.52em}
</style></head><body>
<img class="art" src="${artUri("limit-tall.jpg")}" alt="">
<img class="logo" src="${artUri("logo-dark.svg")}" alt="Balans">
<div class="pill">Balans Pro</div>
<h1><span>This is yours.</span><span class="m">Keep sending it.</span></h1>
<p class="sub">Your ${n} free documents are used. Pro keeps your logo, colour and design on every invoice.</p>
<div class="sheet"><img src="data:image/png;base64,${sheetPng.toString("base64")}" alt=""></div>
<div class="price">
  <div><p class="amount">${naira(priceKobo)}</p><p class="per">a month, or ${naira(yearPriceKobo)} a year</p></div>
  <div class="cta">Reply UPGRADE</div>
</div>
</body></html>`;
}

/**
 * The card as a PNG, drawn from their last trial document. Null when there is
 * none to draw or Chrome is not here; the caller has a stock picture.
 */
export async function drawLimitCard(userId: string, allowance: number): Promise<{ documentId: string; png: Buffer } | null> {
  if (!rendererAvailable()) return null;
  const documentId = await lastTrialDocument(userId);
  if (!documentId) return null;
  const sheet = await documentSheetHtml(documentId);
  if (!sheet) return null;
  const sheetPng = await renderPng(sheet, SHEET_W, SHEET_H, { sheet: true });
  return { documentId, png: await renderPng(limitCardHtml(sheetPng, allowance), LIMIT_W, LIMIT_H) };
}

/** The card as an uploaded media id, or null for the stock card. */
export async function brandedLimitCard(
  userId: string,
  allowance: number,
  log: FastifyBaseLogger,
): Promise<string | null> {
  try {
    const last = await lastTrialDocument(userId);
    if (!last) return null;
    const hit = cache.get(userId);
    if (hit && hit.documentId === last && Date.now() - hit.at < KEEP_MS) return hit.mediaId;

    const started = Date.now();
    const drawn = await drawLimitCard(userId, allowance);
    if (!drawn) return null;
    const up = await uploadDocument(drawn.png, "pro.png", "image/png");
    if (!up.ok) {
      log.warn({ userId, reason: up.reason }, "branded limit card could not be uploaded");
      return null;
    }
    cache.set(userId, { documentId: drawn.documentId, mediaId: up.mediaId, at: Date.now() });
    log.info({ userId, ms: Date.now() - started }, "branded limit card drawn");
    return up.mediaId;
  } catch (e) {
    log.warn({ userId, err: (e as Error).message }, "branded limit card could not be drawn");
    return null;
  }
}
