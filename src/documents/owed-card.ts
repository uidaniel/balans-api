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
import { logoAvailable, logoSvg } from "../brand/logo.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng } from "../pdf/chrome.ts";
import { uploadDocument } from "../whatsapp/client.ts";
import { esc } from "./page.ts";
import type { Debtors } from "./queries.ts";

/** Square and large, for the same reasons as the draft card. */
const CARD = 1080;

/** How many debts fit before the card stops being glanceable. */
const SHOWN = 6;

const INK = "#10231C";
const CREAM = "#F6F1E7";
const MARIGOLD = "#F5B82E";
const CLAY = "#C2593F";
const MOSS = "#3F8F5F";

export function owedHtml(owed: Debtors, today: Civil): string {
  const late = owed.rows.filter((d) => (d.daysLate ?? 0) > 0);
  const lateKobo = late.reduce((t, d) => t + d.outstandingKobo, 0);
  const rows = owed.rows.slice(0, SHOWN);
  const hidden = owed.rows.length - rows.length + owed.more;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
${fontFaces(["sans", "display"])}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${CARD}px;height:${CARD}px;background:${CREAM};font-family:${FONT.sans};
  color:${INK};-webkit-font-smoothing:antialiased}
.card{width:100%;height:100%;padding:70px 64px;display:flex;flex-direction:column}
.mark{display:flex;align-items:center;gap:14px;margin-bottom:44px}
.word{font-family:${FONT.display};font-size:40px;font-weight:800;letter-spacing:-.02em}
.word i{font-style:normal;color:${MARIGOLD}}
h1{font-size:30px;font-weight:600;color:rgba(16,35,28,.6);letter-spacing:.01em}
.total{font-family:${FONT.display};font-size:96px;font-weight:800;letter-spacing:-.03em;
  line-height:1.05;margin:10px 0 6px}
/*
 * The late figure, which is the line this card exists for. A total tells
 * somebody how much is outstanding; this tells them how much is a problem.
 */
.late{font-size:30px;font-weight:600;color:${CLAY}}
.clear{font-size:30px;font-weight:600;color:${MOSS}}
.list{margin-top:44px;border-top:2px solid rgba(16,35,28,.12);padding-top:8px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:24px;
  padding:19px 0;border-bottom:1px solid rgba(16,35,28,.08)}
.who{font-size:30px;font-weight:600}
.sub{font-size:23px;color:rgba(16,35,28,.5);margin-top:3px}
.row.od .sub{color:${CLAY}}
.amt{font-family:${FONT.display};font-size:33px;font-weight:700;white-space:nowrap}
.more{margin-top:auto;padding-top:26px;font-size:25px;color:rgba(16,35,28,.5)}
</style></head><body><div class="card">

<div class="mark">${logoAvailable() ? logoSvg("56px") : `<span class="word">bala<i>n</i>s</span>`}</div>

<h1>Owed to you</h1>
<p class="total">${esc(formatNaira(owed.totalKobo))}</p>
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
    const up = await uploadDocument(png, "owed.png", "image/png");

    if (!up.ok) {
      log.warn({ reason: up.reason }, "owed card could not be uploaded, sending the words");
      return null;
    }

    log.info({ ms: Date.now() - started, bytes: png.length }, "owed card drawn");
    return up.mediaId;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "owed card could not be drawn, sending the words");
    return null;
  }
}
