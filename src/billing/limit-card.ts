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

import { formatNaira } from "../../core/totals.ts";
import { markSvg } from "../brand/logo.ts";
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
  const perMonth = formatNaira(Math.round(defaults.plans.pro.yearPriceKobo / 12));
  const n = WORDS[allowance] ?? String(allowance);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces(["sans", "display"])}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${LIMIT_W}px;height:${LIMIT_H}px}
body{background:#10231c;color:#f6f1e7;font-family:${FONT.sans};position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.orb{position:absolute;width:760px;height:760px;border-radius:50%;background:#28331f;right:-300px;bottom:-260px}
.mark{position:absolute;left:80px;top:84px}
.pill{position:absolute;right:80px;top:80px;height:52px;padding:0 26px;border-radius:999px;background:#f5b82e;color:#10231c;
font-family:${FONT.display};font-weight:700;font-size:24px;letter-spacing:-.02em;display:flex;align-items:center}
h1{position:absolute;left:78px;top:188px;font-family:${FONT.display};font-weight:800;font-size:96px;line-height:.9;letter-spacing:-.05em}
.sub{position:absolute;left:80px;top:410px;width:880px;font-size:32px;line-height:1.35;color:rgba(246,241,231,.66)}
.sheet{position:absolute;left:140px;top:560px;width:800px;transform:rotate(-3deg);transform-origin:top left;border-radius:18px;
overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45);background:#fff}
.sheet img{display:block;width:800px;height:auto}
.foot{position:absolute;left:0;right:0;bottom:0;height:250px;background:linear-gradient(180deg,rgba(16,35,28,0),#10231c 42%)}
.price{position:absolute;left:78px;bottom:78px;font-family:${FONT.display};font-weight:800;font-size:78px;letter-spacing:-.05em;
display:flex;align-items:baseline;gap:14px;line-height:1}
.price span{font-size:30px;font-weight:700;letter-spacing:-.01em;color:rgba(246,241,231,.66)}
.big{position:absolute;right:80px;bottom:72px}
</style></head><body>
<div class="orb"></div>
<div class="mark">${markSvg("44px")}</div>
<div class="pill">Balans Pro</div>
<h1>This is yours.<br>Keep sending it.</h1>
<p class="sub">Your ${n} free documents are used. Pro keeps your logo, colour and design on every invoice.</p>
<div class="sheet"><img src="data:image/png;base64,${sheetPng.toString("base64")}" alt=""></div>
<div class="foot"></div>
<p class="price">${perMonth}<span>/ month, yearly</span></p>
<div class="big">${markSvg("120px")}</div>
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
