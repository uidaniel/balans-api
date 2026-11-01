/**
 * The month, as a picture over the summary on the 1st (1 November 2026).
 *
 * The summary was a block of figures in a grey bubble, and it is the one
 * message nobody asked for, so it should look like something. Same two
 * layers as the cards: the gold 3D objects are `assets/brand/art/month.jpg`,
 * made once in Google Flow with no words on it, and the month is set here in
 * Onest, so it is always the right month and spelled right.
 *
 * Landscape, because it is the header of a message with buttons under it,
 * and a square there pushes the figures below the fold.
 *
 * Nothing private on it: the month and the year. So it is served by URL,
 * like the Pro card, built once a month and kept.
 */

import { artUri } from "./cards.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng, rendererAvailable } from "../pdf/chrome.ts";
import { env } from "../config.ts";

export const BANNER_W = 1920;
export const BANNER_H = 1080;

// prettier-ignore
const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"] as const;

export function monthBannerHtml(month: number, year: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces(["brand"])}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${BANNER_W}px;height:${BANNER_H}px;overflow:hidden;background:#08130f}
body{position:relative;color:#f6f1e7;font-family:${FONT.brand};-webkit-font-smoothing:antialiased}
.art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.logo{position:absolute;left:120px;top:110px;height:96px}
.kick{position:absolute;left:124px;top:520px;font-weight:500;font-size:44px;letter-spacing:-.005em;color:#f5b82e}
h1{position:absolute;left:112px;top:580px;font-weight:400;font-size:230px;line-height:1;letter-spacing:-.05em}
.year{position:absolute;left:124px;top:840px;font-size:64px;letter-spacing:-.01em;color:rgb(246 241 231/.5)}
</style></head><body>
<img class="art" src="${artUri("month.jpg")}" alt="">
<img class="logo" src="${artUri("logo-dark.svg")}" alt="Balans">
<p class="kick">Your month</p>
<h1>${MONTHS[month - 1]}</h1>
<p class="year">${year}</p>
</body></html>`;
}

const cache = new Map<string, Buffer>();

/** The banner for a month, built once and kept. Null with no browser to draw it. */
export async function monthBanner(month: number, year: number): Promise<Buffer | null> {
  if (!rendererAvailable()) return null;
  const key = `${year}-${month}`;
  const had = cache.get(key);
  if (had) return had;
  const jpg = await renderPng(monthBannerHtml(month, year), BANNER_W, BANNER_H, { jpeg: true });
  cache.set(key, jpg);
  return jpg;
}

/** Where Meta fetches it from: brand.ts serves this path. */
export function monthBannerUrl(month: number, year: number): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/brand/month/${year}-${String(month).padStart(2, "0")}.jpg`;
}
