/**
 * A month's money, drawn.
 *
 * /summary was four labelled rows, and the first one somebody reads is "Paid:
 * ₦0" — which is accurate, and reads like nothing happened. It isn't nothing:
 * ₦1,953,275 went out and none of it has landed yet, and that is a different
 * month from one where nobody was invoiced at all. A card can put the thing
 * that happened first and the thing that hasn't underneath it.
 *
 * Marigold, where the draft receipt is cream. The receipt is a document about
 * one invoice and wants to look like paper; this is a report about a month and
 * wants to look like the brand. It also makes the two instantly different in a
 * scrolled-back chat, which is the only place anybody compares them.
 *
 * Same rule as every other card here: this REPLACES nothing. The words stay as
 * the body of the message, because a picture cannot be searched in a chat,
 * copied or read aloud, and Chrome can fail. See `periodCard`.
 */

import type { FastifyBaseLogger } from "fastify";

import { formatNaira } from "../../core/totals.ts";
import { logoAvailable, logoSvg } from "../brand/logo.ts";
import { fontFaces, FONT } from "../pdf/fonts.ts";
import { renderPng } from "../pdf/chrome.ts";
import { publishCard } from "./card-link.ts";
import { esc } from "./page.ts";
import type { Summary } from "./queries.ts";

const CARD = 1080;

const INK = "#10231C";
const MARIGOLD = "#F5B82E";
const CLAY = "#C2593F";

/** One figure with its label above it, in the size the number deserves. */
const line = (label: string, value: string, cls = ""): string =>
  `<div class="row${cls}"><p class="k">${esc(label)}</p><p class="v">${esc(value)}</p></div>`;

export function periodHtml(s: Summary): string {
  /*
   * The headline is what landed, unless nothing has.
   *
   * "Paid ₦0" as the biggest number on the card is true and useless — it is
   * the answer to a question nobody asked in a month where they invoiced
   * nearly two million. When nothing has been paid the card leads with what
   * is outstanding, which is the number that actually describes the month.
   */
  const paidLed = s.paidKobo > 0;
  const headline = paidLed ? s.paidKobo : s.outstandingKobo;
  const headlineLabel = paidLed ? "Paid to you" : "Waiting to be paid";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
${fontFaces(["sans", "display"])}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${CARD}px;height:${CARD}px;background:${MARIGOLD};font-family:${FONT.sans};
  color:${INK};-webkit-font-smoothing:antialiased}
.card{width:100%;height:100%;padding:70px 64px;display:flex;flex-direction:column}
.mark{display:flex;align-items:center;gap:14px;margin-bottom:40px}
.word{font-family:${FONT.display};font-size:40px;font-weight:800;letter-spacing:-.02em}
/* The counter-form stays ink on marigold rather than marigold on marigold. */
.word i{font-style:normal;color:rgba(16,35,28,.45)}
h1{font-size:30px;font-weight:600;color:rgba(16,35,28,.62);letter-spacing:.08em;
  text-transform:uppercase}
.big{font-family:${FONT.display};font-size:104px;font-weight:800;letter-spacing:-.03em;
  line-height:1.03;margin:14px 0 4px}
.biglabel{font-size:29px;font-weight:600;color:rgba(16,35,28,.62)}
.rows{margin-top:auto;background:rgba(255,255,255,.62);border-radius:28px;padding:10px 32px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:24px;
  padding:24px 0;border-bottom:1px solid rgba(16,35,28,.1)}
.row:last-child{border-bottom:0}
.row .k{font-size:29px;color:rgba(16,35,28,.62)}
.row .v{font-family:${FONT.display};font-size:36px;font-weight:700;white-space:nowrap}
.row.late .v{color:${CLAY}}
.best{margin-top:28px;font-size:26px;color:rgba(16,35,28,.62)}
.best b{font-weight:600;color:${INK}}
</style></head><body><div class="card">

<div class="mark">${logoAvailable() ? logoSvg("56px") : `<span class="word">bala<i>n</i>s</span>`}</div>

<h1>${esc(s.period.label)}</h1>
<p class="big">${esc(formatNaira(headline))}</p>
<p class="biglabel">${esc(headlineLabel)}</p>

<div class="rows">
${paidLed ? "" : line("Paid so far", formatNaira(s.paidKobo))}
${line("Invoiced", `${formatNaira(s.invoicedKobo)} across ${s.documents}`)}
${paidLed && s.outstandingKobo > 0 ? line("Outstanding", formatNaira(s.outstandingKobo)) : ""}
${s.overdueKobo > 0 ? line("Overdue", formatNaira(s.overdueKobo), " late") : ""}
</div>

${
  s.topClients.length
    ? `<p class="best">Best client: <b>${esc(s.topClients[0]!.name)}</b> · ${esc(formatNaira(s.topClients[0]!.paidKobo))}</p>`
    : ""
}
</div></body></html>`;
}

/**
 * The card as a WhatsApp media id, or null to send the words alone.
 *
 * Null on every failure, deliberately: a render that does not come back must
 * cost somebody a picture, never their answer.
 */
export async function periodCard(
  userId: string,
  s: Summary,
  log: FastifyBaseLogger,
): Promise<string | null> {
  // A month with nothing in it is a card with three zeroes on it, which says
  // less than the sentence does.
  if (s.documents === 0) return null;

  const started = Date.now();
  try {
    const png = await renderPng(periodHtml(s), CARD, CARD);
    const url = await publishCard(userId, png, log);

    log.info({ ms: Date.now() - started, bytes: png.length, parked: Boolean(url) }, "summary card drawn");
    return url;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "summary card could not be drawn, sending the words");
    return null;
  }
}
