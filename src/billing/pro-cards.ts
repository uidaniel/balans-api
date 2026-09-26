/**
 * The two Pro offer cards, drawn from the numbers they state.
 *
 *   npm run cards     rewrites assets/brand/limit.png and upgrade.png
 *
 * They were painted by hand, so every figure on them — five documents,
 * ₦4,000, eight designs, "no Balans fee" — was a claim no code could keep
 * true. On 26 September 2026 the Free limit went to three and the Balans fee
 * stopped existing, and both cards were wrong at once. Now they are an HTML
 * page filled in from the config and rendered by the same Chrome that makes
 * the PDFs, so changing a price is a command, not a redraw.
 *
 * The layout is the original's: ink ground, a marigold pill, the headline in
 * Geist, a checklist, the price at the foot and the mark beside it.
 */

import { writeFileSync } from "node:fs";
import { defaults } from "../config.ts";
import { formatNaira } from "../../core/totals.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { markSvg } from "../brand/logo.ts";
import { availableTo } from "../pdf/templates.ts";

export const CARD_W = 2160;
export const CARD_H = 2700;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number): string => WORDS[n] ?? String(n);
const Cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What Pro adds, as the card lists it. Only things Free does not have. */
export function proPoints(): string[] {
  return [
    "Unlimited invoices and quotes",
    "Your logo on every invoice",
    `${availableTo("pro").length} invoice designs`,
    "Invoices sent to your client\u2019s WhatsApp",
    "Automatic reminders to late clients",
    "Deposits and milestones",
  ];
}

export function proCardHtml(kind: "limit" | "upgrade"): string {
  const limit = defaults.plans.free.documentsPerMonth ?? 0;
  const price = formatNaira(defaults.plans.pro.priceKobo);
  // "Three done." is a fact about the reader, so it is only on the card sent
  // to somebody who has used them all. See pro-card.test.ts.
  const headline = kind === "limit" ? [`${Cap(word(limit))} done.`, "Go unlimited."] : ["Upgrade", "to Pro."];
  const sub = `The free plan covers ${word(limit)} documents a month. Pro takes the limit off.`;
  const tick =
    `<svg viewBox="0 0 24 24" width="58" height="58" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5" ` +
    `fill="none" stroke="#f5b82e" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces(["sans", "display"])}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${CARD_W}px;height:${CARD_H}px}
body{background:#10231c;color:#f6f1e7;font-family:${FONT.sans};position:relative;overflow:hidden;
-webkit-font-smoothing:antialiased}
.orb{position:absolute;width:1140px;height:1140px;border-radius:50%;background:#28331f;right:-440px;top:-420px}
.mark{position:absolute;left:162px;top:172px}
.pill{position:absolute;right:162px;top:166px;height:100px;padding:0 50px;border-radius:999px;background:#f5b82e;
color:#10231c;font-family:${FONT.display};font-weight:700;font-size:46px;letter-spacing:-.02em;display:flex;align-items:center}
h1{position:absolute;left:156px;top:395px;font-family:${FONT.display};font-weight:800;font-size:212px;line-height:.86;
letter-spacing:-.055em}
.sub{position:absolute;left:162px;top:815px;width:1480px;font-size:63px;line-height:1.36;color:rgba(246,241,231,.62);
letter-spacing:-.005em}
ul{position:absolute;left:162px;right:162px;top:1072px;list-style:none;border-top:3px solid rgba(246,241,231,.12)}
li{display:flex;align-items:center;gap:52px;height:140px;border-bottom:3px solid rgba(246,241,231,.12);font-size:64px;
letter-spacing:-.01em}
li svg{flex:none}
.reply{position:absolute;left:162px;top:2345px;font-family:${FONT.display};font-weight:700;font-size:46px;letter-spacing:.09em;
color:rgba(246,241,231,.62)}
.reply b{color:#f5b82e;font-weight:700}
.price{position:absolute;left:156px;top:2410px;font-family:${FONT.display};font-weight:800;font-size:150px;letter-spacing:-.05em;
display:flex;align-items:baseline;gap:22px;line-height:1}
.price span{font-size:60px;font-weight:700;letter-spacing:-.01em;color:rgba(246,241,231,.62)}
.big{position:absolute;right:162px;bottom:162px}
</style></head><body>
<div class="orb"></div>
<div class="mark">${markSvg("86px")}</div>
<div class="pill">Balans Pro</div>
<h1>${headline.join("<br>")}</h1>
<p class="sub">${sub}</p>
<ul>${proPoints().map((p) => `<li>${tick}<span>${p}</span></li>`).join("")}</ul>
<p class="reply">REPLY <b>UPGRADE</b></p>
<p class="price">${price}<span>/ month</span></p>
<div class="big">${markSvg("242px")}</div>
</body></html>`;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { renderPng, closeRenderer } = await import("../pdf/chrome.ts");
  try {
    for (const kind of ["limit", "upgrade"] as const) {
      const png = await renderPng(proCardHtml(kind), CARD_W, CARD_H);
      const out = new URL(`../../assets/brand/${kind}.png`, import.meta.url);
      writeFileSync(out, png);
      console.log(`wrote assets/brand/${kind}.png`);
    }
  } finally {
    await closeRenderer();
  }
}
