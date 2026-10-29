/**
 * What people owe you, drawn.
 *
 * /owed was a stack of names and figures, which is the shape of a query
 * result rather than the shape of money. The one question it answers is "how
 * bad is it" — and the answer is not the total, it is how much of the total is
 * already late. A list buries that; a card can put it first.
 *
 * Same discipline as the draft receipt card: this REPLACES nothing. The words
 * stay as the body of the message, because a picture cannot be searched in a
 * chat, copied, or read aloud, and Chrome can fail. See `owedCard`.
 *
 * At most six debts are drawn. More than that stops being a picture somebody
 * reads at a glance and becomes a table they squint at — and the summary page
 * behind the button lists every one of them.
 */

import type { FastifyBaseLogger } from "fastify";

import { formatFriendly, type Civil } from "../../core/dates.ts";
import { formatNaira } from "../../core/totals.ts";
import { artUri, NGN_CSS, ngn } from "../brand/cards.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng } from "../pdf/chrome.ts";
import { publishCard } from "./card-link.ts";
import { esc } from "./page.ts";
import type { Debtors } from "./queries.ts";

/** Square and large, for the same reasons as the draft card. */
const CARD = 1080;

/** How many debts fit before the card stops being glanceable. */
const SHOWN = 6;

const INK = "#10231C";
const CREAM = "#F6F1E7";
const CORAL = "#C2593F";
const MINT = "#3F8F5F";

export function owedHtml(owed: Debtors, today: Civil): string {
  const late = owed.rows.filter((d) => (d.daysLate ?? 0) > 0);
  const lateKobo = late.reduce((t, d) => t + d.outstandingKobo, 0);
  const rows = owed.rows.slice(0, SHOWN);
  const hidden = owed.rows.length - rows.length + owed.more;

  /*
   * Cream, with soft gold light from one corner (29 October 2026). The art is
   * a picture with no words on it, and everything that is somebody's money
   * is type over it. Light on purpose: the summary is gold and the breakdown
   * is paper on night green, so the three never look alike in a chat.
   */
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
${fontFaces(["brand"])}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${CARD}px;height:${CARD}px;background:${CREAM};font-family:${FONT.brand};
  color:${INK};-webkit-font-smoothing:antialiased;position:relative;overflow:hidden}
.art{position:absolute;inset:0;width:100%;height:100%}
.card{position:relative;width:100%;height:100%;padding:72px 72px 64px;display:flex;flex-direction:column}
.mark img{height:62px;display:block}
h1{margin-top:64px;font-size:34px;font-weight:400;color:rgba(16,35,28,.6)}
.total{font-size:150px;font-weight:500;letter-spacing:-.055em;line-height:1;margin:16px 0 18px}
/*
 * The late figure, which is the line this card exists for. A total tells
 * somebody how much is outstanding; this tells them how much is a problem.
 */
.late{font-size:32px;font-weight:500;color:${CORAL}}
.clear{font-size:32px;font-weight:500;color:${MINT}}
.list{margin-top:44px;padding:8px 36px;border-radius:36px;background:rgba(255,255,255,.62);
  backdrop-filter:blur(30px);box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),0 30px 60px -40px rgba(16,35,28,.35)}
.row{display:flex;align-items:center;justify-content:space-between;gap:24px;
  padding:22px 0;border-bottom:2px solid rgba(16,35,28,.07)}
.row:last-child{border-bottom:0}
.who{font-size:32px;font-weight:500;letter-spacing:-.01em}
.sub{font-size:24px;color:rgba(16,35,28,.5);margin-top:4px}
.row.od .sub{color:${CORAL}}
.amt{font-size:36px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
.more{margin-top:auto;padding-top:24px;font-size:25px;color:rgba(16,35,28,.5)}
${NGN_CSS}
</style></head><body>
<img class="art" src="${artUri("owed.jpg")}" alt="">
<div class="card">

<div class="mark"><img src="${artUri("logo-light.svg")}" alt="Balans"></div>

<h1>Owed to you</h1>
<p class="total">${ngn(esc(formatNaira(owed.totalKobo)))}</p>
${
  lateKobo > 0
    ? `<p class="late">${esc(formatNaira(lateKobo))} of it is already late</p>`
    : `<p class="clear">None of it is late yet</p>`
}

<div class="list">
${rows
  .map((d) => {
    const od = (d.daysLate ?? 0) > 0;
    const when = d.dueDate
      ? od
        ? `${d.daysLate} day${d.daysLate === 1 ? "" : "s"} late`
        : `due ${formatFriendly(d.dueDate, today)}`
      : "no date";
    return `<div class="row${od ? " od" : ""}">
      <div><p class="who">${esc(d.clientName)}${d.number ? ` #${d.number}` : ""}</p>
      <p class="sub">${esc(when)}</p></div>
      <p class="amt">${esc(formatNaira(d.outstandingKobo))}</p></div>`;
  })
  .join("")}
</div>

${hidden > 0 ? `<p class="more">and ${hidden} more — tap View Summary for all of them</p>` : ""}
</div></body></html>`;
}

/**
 * The card as a WhatsApp media id, or null to send the words alone.
 *
 * Null on every failure, deliberately. A render that does not come back must
 * cost somebody a picture, never their answer.
 *
 * Uploaded rather than linked, for the same reason as the draft receipt: this
 * image carries client names and what they owe, and a URL for that is a public
 * page for private money however unguessable the path.
 */
export async function owedCard(
  userId: string,
  owed: Debtors,
  today: Civil,
  log: FastifyBaseLogger,
): Promise<string | null> {
  // Nothing outstanding is a card with one figure on it and that figure is
  // zero, which is worse than the sentence saying so.
  if (!owed.rows.length) return null;

  const started = Date.now();
  try {
    const png = await renderPng(owedHtml(owed, today), CARD, CARD);
    const url = await publishCard(userId, png, log);

    log.info({ ms: Date.now() - started, bytes: png.length, parked: Boolean(url) }, "owed card drawn");
    return url;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "owed card could not be drawn, sending the words");
    return null;
  }
}
