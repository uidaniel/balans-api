/**
 * The cards the bot sends in chat, drawn from code.
 *
 *   npm run cards     rewrites the eight in assets/brand/*.jpg
 *
 * Rebranded on 29 October 2026 with balans.ng and the posters: night green,
 * one soft marigold light (a glare, a satin printed in halftone, or ribbed
 * glass, a different one per card), a gold 3D object made in Google Flow, and
 * light Onest type in two tones. Each card is two layers. The picture is
 * `assets/brand/art/<card>.jpg`, made once and kept, with no words on it. The
 * words are this file, so a price, a count or a month is a value from the
 * config and never something painted on that the config can drift away from.
 *
 * JPEG rather than PNG: a lit render with grain is 6MB as a PNG, and WhatsApp
 * refuses an image over 5MB.
 *
 * Onest has no naira sign, so ₦ is drawn as an N with two bars (`.ngn`), the
 * way a sign painter would. A fallback face would put a different design of
 * the sign beside Onest's digits at three hundred pixels high.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatNaira } from "../../core/totals.ts";
import { defaults } from "../config.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { availableTo } from "../pdf/templates.ts";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/brand");

export const CARD_W = 2160;
export const SQUARE = 2160;
export const TALL = 2700;

export const CARDS = [
  "welcome",
  "setup-done",
  "cheatsheet",
  "paid-tonight",
  "paid-tomorrow",
  "limit",
  "upgrade",
  "pro",
] as const;
export type Card = (typeof CARDS)[number];

/**
 * Four by five for the cheatsheet, which carries ten rows; square for the
 * rest. The offer cards were four by five too and read as a long strip in
 * the chat (29 October 2026), so their price panel lies across the foot.
 */
export const heightOf = (card: Card): number => (card === "cheatsheet" ? TALL : SQUARE);

/* -------------------------------------------------------------------------- */

const art = new Map<string, string>();
/** A file in assets/brand/art as a data URI, read once. */
export function artUri(file: string): string {
  let uri = art.get(file);
  if (!uri) {
    const bytes = readFileSync(path.join(ASSETS, "art", file));
    uri = `data:${file.endsWith(".svg") ? "image/svg+xml" : "image/jpeg"};base64,${bytes.toString("base64")}`;
    art.set(file, uri);
  }
  return uri;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number): string => WORDS[n] ?? String(n);
const Cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** ₦ in Onest's place: see the note at the top. */
export const ngn = (html: string): string => html.replace(/₦/g, '<span class="ngn">N</span>');
export const naira = (kobo: number): string => ngn(formatNaira(kobo));
/**
 * Every ₦ a reader sees on a page, drawn, and none inside a tag: an
 * aria-label or a title keeps the real sign, which is what a screen reader
 * should read out.
 */
export const ngnText = (html: string): string => html.replace(/>([^<]*)</g, (_, text: string) => `>${ngn(text)}<`);
/** The two bars, for any page that sets a figure with `ngn`. */
export const NGN_CSS =
  ".ngn{position:relative;display:inline-block;line-height:1}" +
  '.ngn::before,.ngn::after{content:"";position:absolute;left:-.06em;right:-.06em;height:.065em;background:currentColor;top:.36em}' +
  ".ngn::after{top:.52em}";

const TICK =
  '<svg viewBox="0 0 24 24" width="46" height="46" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5" ' +
  'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${CARD_W}px;overflow:hidden;background:#08130f}
body{position:relative;color:#f6f1e7;font-family:${FONT.brand};-webkit-font-smoothing:antialiased}
.art{position:absolute;left:0;top:0;width:100%;display:block}
.logo{position:absolute;left:150px;top:150px;height:132px}
.pill{position:absolute;right:150px;top:158px;height:116px;padding:0 56px;border-radius:999px;display:flex;align-items:center;
gap:22px;font-weight:500;font-size:48px;letter-spacing:-.01em;color:#10231c;white-space:nowrap;
background:linear-gradient(180deg,#ffd877,#f5b82e);box-shadow:inset 0 4px 0 rgb(255 250 230/.6),0 30px 60px -30px rgb(245 184 46/.6)}
.pill.ink{background:#10231c;color:#f6f1e7;box-shadow:inset 0 0 0 3px rgb(246 241 231/.14)}
.pill.glass{position:static;height:112px;padding:0 46px;font-size:50px;font-weight:400;color:#f6f1e7;background:rgb(246 241 231/.08);
box-shadow:inset 0 3px 0 rgb(255 255 255/.08),inset 0 0 0 3px rgb(246 241 231/.14)}
h1{position:absolute;left:144px;font-weight:400;font-size:200px;line-height:.98;letter-spacing:-.05em}
h1 span{display:block}
h1 .m{color:rgb(246 241 231/.48)}
.sub{position:absolute;left:150px;font-size:64px;line-height:1.34;letter-spacing:-.01em;color:rgb(246 241 231/.66)}
.kick{font-weight:500;font-size:46px;letter-spacing:-.005em;color:#f5b82e;margin-bottom:28px}
.chip{display:inline-block;padding:44px 56px;border-radius:56px 56px 56px 14px;font-size:64px;line-height:1.3;letter-spacing:-.01em;
background:rgb(246 241 231/.09);box-shadow:inset 0 3px 0 rgb(255 255 255/.08),inset 0 0 0 3px rgb(246 241 231/.15)}
.foot{position:absolute;left:150px;bottom:150px}
.ngn{position:relative;display:inline-block;line-height:1}
.ngn::before,.ngn::after{content:"";position:absolute;left:-.06em;right:-.06em;height:.065em;background:currentColor;top:.36em}
.ngn::after{top:.52em}
`;

const page = (card: Card, body: string, extra = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces(["brand"])}${STYLE}${extra}
html,body{height:${heightOf(card)}px}</style></head><body>
<img class="art" src="${artUri(`${card}.jpg`)}" alt="">
<img class="logo" src="${artUri("logo-dark.svg")}" alt="Balans">
${body}
</body></html>`;

const headline = (top: number, line: string, muted: string, size = 200): string =>
  `<h1 style="top:${top}px;font-size:${size}px"><span>${line}</span><span class="m">${muted}</span></h1>`;

/* -------------------------------------------------------------------------- */

/** What Pro adds, as the offer cards list it. Only things Free does not have. */
export function proPoints(): string[] {
  return [
    "Unlimited invoices and quotes",
    "Your logo on every invoice",
    `${availableTo("pro").length} invoice designs`,
    "Invoices sent to your client’s WhatsApp",
    "Automatic reminders to late clients",
  ];
}

/** The same, short enough for the chips on the membership card. */
const proChips = (): string[] => [
  "Unlimited invoices",
  "Your logo on invoices",
  `All ${availableTo("pro").length} designs`,
  "Sent to their WhatsApp",
  "Automatic reminders",
];

/** "Three done. Go unlimited." and "Upgrade to Pro.", with the price as the centre of the card. */
function offer(kind: "limit" | "upgrade"): string {
  const limit = defaults.plans.free.trialDocuments;
  const { priceKobo, yearPriceKobo } = defaults.plans.pro;
  // "Three done." is a fact about the reader, so it is only on the card sent
  // to somebody who has used them all. See pro-card.test.ts.
  const [line, muted] = kind === "limit" ? [`${Cap(word(limit))} done.`, "Go unlimited."] : ["Upgrade", "to Pro."];
  const sub =
    kind === "limit"
      ? `Your ${word(limit)} free documents are used. Pro keeps you sending, monthly or yearly.`
      : `Your first ${word(limit)} documents are free. Pro takes the limit off.`;

  return page(
    kind,
    `<div class="pill ink">Balans Pro</div>
${headline(400, line, muted, 180)}
<p class="sub" style="top:790px;width:1220px;font-size:58px">${sub}</p>
<ul class="points">${proPoints()
      .map((p) => `<li><span class="tick">${TICK}</span>${p}</li>`)
      .join("")}</ul>
<div class="price">
  <div>
    <p class="amount">${naira(priceKobo)}</p>
    <p class="per">a month, or ${naira(yearPriceKobo)} a year</p>
  </div>
  <div class="pill" style="position:static;height:132px;font-size:52px;padding:0 66px">Reply UPGRADE</div>
</div>`,
    `.points{position:absolute;left:150px;right:150px;top:1000px;list-style:none}
.points li{display:flex;align-items:center;gap:40px;height:96px;border-top:3px solid rgb(246 241 231/.1);font-size:52px;letter-spacing:-.01em}
.tick{color:#f5b82e;display:flex}
.price{position:absolute;left:150px;right:150px;bottom:130px;height:420px;border-radius:64px;background:rgb(8 19 15/.5);
backdrop-filter:blur(70px) saturate(130%);box-shadow:inset 0 4px 0 rgb(255 240 200/.16),inset 0 0 0 3px rgb(246 241 231/.14),
0 60px 120px -60px rgb(0 0 0/.6);display:flex;align-items:center;justify-content:space-between;padding:0 80px}
.amount{font-size:240px;font-weight:500;line-height:1;letter-spacing:-.055em}
.per{font-size:52px;line-height:1.2;color:rgb(246 241 231/.7);margin-top:22px}`,
  );
}

/* -------------------------------------------------------------------------- */

/*
 * The membership card's face, as it sits in the art: the four corners of the
 * gold card's face, measured off the Flow render by fitting a line to each
 * edge (not by taking the extreme pixels, which sit on the rounded corners),
 * in the 1024px render, and where the render is placed on the card.
 */
const FACE = {
  corners: [
    [141.6, 297.1],
    [842.7, 249.8],
    [880.5, 721.7],
    [180.2, 772],
  ],
  at: { x: 420, y: 230, size: 1320, of: 1024 },
  /** The engraving is laid out on a flat card this size, then projected. */
  w: 1000,
  h: 630,
} as const;

/** The CSS matrix3d that projects a FACE.w × FACE.h box onto the card's four corners. */
export function faceMatrix(): string {
  const k = FACE.at.size / FACE.at.of;
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = FACE.corners.map(([x, y]) => [
    FACE.at.x + x * k,
    FACE.at.y + y * k,
  ]) as unknown as [[number, number], [number, number], [number, number], [number, number]];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const n = (v: number) => +v.toFixed(6);
  const [W, H] = [FACE.w, FACE.h];
  return `matrix3d(${[a / W, d / W, 0, g / W, b / H, e / H, 0, h / H, 0, 0, 1, 0, x0, y0, 0, 1].map(n).join(",")})`;
}

// prettier-ignore
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The coin, as a disc with the b cut through it. */
const COIN =
  '<svg viewBox="0 0 120 120"><mask id="b"><circle cx="60" cy="60" r="60" fill="#fff"/><g fill="#000">' +
  '<rect x="38" y="18" width="15" height="82" rx="3"/><circle cx="68" cy="74" r="19" fill="none" stroke="#000" stroke-width="14"/>' +
  '<rect x="25" y="25" width="41" height="8" rx="2"/><rect x="25" y="38" width="41" height="8" rx="2"/></g></mask>' +
  '<circle cx="60" cy="60" r="60" mask="url(#b)"/></svg>';

/**
 * The membership card. With a month it is engraved "Member since <month>";
 * without one, the stock card has no line at all rather than a wrong month.
 */
export function proCardHtml(month?: number, year?: number): string {
  const since = month && year ? `Member since ${MONTHS[month - 1]} ${year}` : "";
  // Engraved: the cut, darker than the gold (multiply), then a thin light lip
  // along its lower edge (screen), both on the card's own plane.
  const face = (cls: string) => `<div class="face ${cls}">
  <div class="coin">${COIN}</div>
  <div class="word">PRO</div>
  ${since ? `<div class="since">${since}</div>` : ""}
</div>`;

  return page(
    "pro",
    `${face("cut")}${face("lip")}
<div class="pill">${TICK}Payment received</div>
<h1 style="top:1380px;left:0;right:0;text-align:center"><span>You’re on Pro.</span></h1>
<div class="chips">${proChips()
      .map((c) => `<span class="pill glass">${c}</span>`)
      .join("")}</div>`,
    `.face{position:absolute;left:0;top:0;width:${FACE.w}px;height:${FACE.h}px;transform-origin:0 0;transform:${faceMatrix()};font-weight:400}
.face>*{position:absolute}
.coin{left:72px;top:66px;width:96px;height:96px}.coin svg{width:100%;height:100%;display:block}
.word{left:62px;bottom:118px;font-size:230px;letter-spacing:-.04em;line-height:.8}
.since{left:74px;bottom:60px;font-size:36px;letter-spacing:-.01em}
.cut{mix-blend-mode:multiply;color:#9a6a12;fill:#9a6a12}.cut>*{filter:drop-shadow(0 -2px 0 #6b4708)}
.lip{mix-blend-mode:screen;color:#000;fill:#000}.lip>*{filter:drop-shadow(0 3px 0 rgb(255 232 160/.55))}
.chips{position:absolute;left:150px;right:150px;top:1690px;display:flex;flex-wrap:wrap;justify-content:center;gap:28px}`,
  );
}

/* -------------------------------------------------------------------------- */

const COMMANDS: [string, [string, string][]][] = [
  ["Get paid", [["/invoice", "Bill a client, get a payment link"], ["/quote", "Send a quote before the work starts"], ["/collect", "Ask for money, no invoice needed"]]],
  ["Keep track", [["/owed", "Who still owes you"], ["/status", "Is that invoice paid yet?"], ["/summary", "How this month went"]]],
  ["Your account", [["/settings", "Name, payout bank, due days"], ["/design", "How your invoices look"], ["/pro", "Unlimited invoices and more"], ["/help", "What I can do"]]],
];

/** "You've been paid." The two differ only in when the money lands. */
function paid(card: "paid-tonight" | "paid-tomorrow"): string {
  const tonight = card === "paid-tonight";
  return page(
    card,
    `<div class="pill">${TICK}Payment confirmed</div>
${headline(500, "You’ve been paid.", "With Balans.", 184)}
<p class="sub" style="top:940px;width:1060px">Your client paid. The receipt is on its way to them, and your records are updated.</p>
<div class="foot"><p class="kick">${tonight ? "Paid before 10 PM" : "Paid after 10 PM"}</p>
<p style="font-size:96px;letter-spacing:-.04em;line-height:1.02">${tonight ? "In your bank tonight." : "In your bank<br>tomorrow night."}</p></div>`,
  );
}

export function cardHtml(card: Card): string {
  switch (card) {
    case "welcome":
      return page(
        card,
        `<div class="pill">You’re in</div>
${headline(560, "Welcome.", "Let’s get you paid.")}
<p class="sub" style="top:1010px;width:1100px">Your business name and your bank. Then your first invoice is one message.</p>
<div class="foot"><p class="kick">Then just type</p><p class="chip">Invoice Tunde 150k</p></div>`,
      );
    case "setup-done":
      return page(
        card,
        `${headline(520, "You’re set up.", "Send your first invoice.", 184)}
<p class="sub" style="top:940px;width:1240px">Type it like a text: client, amount, what for, and when it’s due. Balans drafts the rest.</p>
<div class="foot"><p class="kick">Like this</p><p class="chip" style="max-width:1500px">Invoice Zenith Homes 350k for duplex 3D render, due Friday</p></div>`,
      );
    case "cheatsheet":
      return page(
        card,
        `${headline(360, "Ten commands.", "Or just type.", 176)}
<div class="cmds">${COMMANDS.map(
          ([group, rows]) =>
            `<p class="kick">${group}</p>` +
            rows.map(([c, d]) => `<div class="row"><span class="c">${c}</span><span class="d">${d}</span></div>`).join(""),
        ).join("")}</div>
<div class="foot"><p class="kick" style="color:rgb(246 241 231/.55)">No slash needed</p><p class="chip">Invoice Tunde 150k for logo design, due Friday</p></div>`,
        `.cmds{position:absolute;left:150px;right:150px;top:770px}
.cmds .kick{margin:44px 0 18px}
.row{display:flex;align-items:center;height:104px;border-top:3px solid rgb(246 241 231/.1);line-height:1}
.c{width:520px;font-size:62px;font-weight:500;color:#f5b82e;letter-spacing:-.01em}
.d{font-size:56px;color:rgb(246 241 231/.72)}`,
      );
    case "paid-tonight":
    case "paid-tomorrow":
      return paid(card);
    case "limit":
    case "upgrade":
      return offer(card);
    case "pro":
      return proCardHtml();
  }
}

/* -------------------------------------------------------------------------- */

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { renderPng, closeRenderer } = await import("../pdf/chrome.ts");
  try {
    for (const card of CARDS) {
      const jpg = await renderPng(cardHtml(card), CARD_W, heightOf(card), { jpeg: true });
      writeFileSync(path.join(ASSETS, `${card}.jpg`), jpg);
      console.log(`wrote assets/brand/${card}.jpg (${Math.round(jpg.length / 1024)}KB)`);
    }
  } finally {
    await closeRenderer();
  }
}
