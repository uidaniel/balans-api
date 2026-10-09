/**
 * The signature page, opened from the chat ("signature").
 *
 * Two ways to make one, because people split cleanly between them: draw it
 * with a finger, or type a name and pick one of a few script faces. Either
 * way the page draws onto a transparent canvas, trims it to the ink and
 * posts a PNG, so what reaches the invoice is the stroke and nothing around
 * it (see src/brand/signature.ts).
 *
 * The token is the only credential and it lasts a day. An expired or unknown
 * one is a 404 that says how to get a new link, not which of the two it was.
 */

import { liveSettingsPath } from "../../settings/page-token.ts";
import type { FastifyInstance } from "fastify";
import { env } from "../../config.ts";
import { logoAvailable, logoSvg, markSvg } from "../../brand/logo.ts";
import {
  clearSignature,
  MAX_SIGNATURE_BYTES,
  ownerOfSignatureToken,
  saveSignature,
  signatureDataUri,
} from "../../brand/signature.ts";
import { sendText } from "../../whatsapp/client.ts";
import { b, lines } from "../../whatsapp/format.ts";

const HTML = "text/html; charset=utf-8";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The script faces offered for a typed signature. All on Google Fonts. */
export const STYLES = [
  "Great Vibes",
  "Dancing Script",
  "Sacramento",
  "Allura",
  "Homemade Apple",
  "Mrs Saint Delafield",
] as const;

/** The link a chat message carries. */
export const signatureUrl = (token: string): string =>
  `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/signature/${token}`;

const CSS = `
:root{--ink:#10231C;--cream:#F6F1E7;--paper:#FFFFFF;--gold:#F5B82E;--line:rgba(16,35,28,.12);--faint:rgba(16,35,28,.55);
--lift:0 0 0 1px rgba(16,35,28,.06),0 1px 2px rgba(16,35,28,.05),0 14px 34px -18px rgba(16,35,28,.25)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:"Instrument Sans","Geist",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;min-height:100dvh;padding:0 0 48px}
/* The head on ink, the card rising out of it: the same shape as the pay
   page, the designs and the settings this is opened from. */
.top{background:var(--ink);color:var(--cream);padding:22px 18px 92px}
.top .in,.wrap{max-width:560px;margin:0 auto}
.back{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px 0 10px;border-radius:999px;margin-bottom:20px;
background:rgba(246,241,231,.08);color:var(--cream);font-weight:600;font-size:13.5px;text-decoration:none}
.back svg{width:15px;height:15px}
.brand{display:flex;align-items:center;gap:8px;font-family:"Geist",sans-serif;font-weight:700;letter-spacing:-.02em;color:var(--cream)}
.brand svg{width:22px;height:22px}
h1{margin-top:22px;font-family:"Geist",sans-serif;font-weight:800;font-size:32px;line-height:1.05;letter-spacing:-.04em}
.lead{margin-top:10px;font-size:15.5px;line-height:1.55;color:rgba(246,241,231,.66);max-width:44ch}
.wrap{padding:0 14px;margin-top:-70px;position:relative}
.card{background:var(--paper);border-radius:24px;padding:18px;box-shadow:var(--lift)}
.card+.card{margin-top:12px}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:999px;background:rgba(16,35,28,.06)}
.tabs button{height:42px;border:0;border-radius:999px;background:transparent;font:inherit;font-weight:600;font-size:15px;color:var(--faint);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:background-color .2s,color .2s}
.tabs button svg{width:17px;height:17px}
.tabs button[aria-selected=true]{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(16,35,28,.12)}
.pane{margin-top:16px}
/* The pad, drawn like the place a pen goes on a printed form: a rule near the
   foot with a cross at its start. */
.pad{position:relative;border-radius:18px;background:#FCFAF6;box-shadow:inset 0 0 0 1px var(--line);touch-action:none}
.pad canvas{display:block;width:100%;height:210px;border-radius:18px;cursor:crosshair;touch-action:none;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.pad .base{position:absolute;left:46px;right:24px;bottom:54px;border-top:1.5px solid rgba(16,35,28,.18);pointer-events:none}
.pad .x{position:absolute;left:22px;bottom:50px;font:600 18px/1 "Geist",sans-serif;color:rgba(16,35,28,.3);pointer-events:none}
.pad .hint{position:absolute;left:0;right:0;top:40%;text-align:center;font-size:15px;color:rgba(16,35,28,.38);pointer-events:none}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:13.5px;color:var(--faint)}
.link{border:0;background:none;font:inherit;font-weight:600;color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.chip{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:999px;border:0;background:rgba(16,35,28,.06);
  font:inherit;font-weight:600;font-size:13.5px;color:var(--ink);cursor:pointer}
.chip svg{width:15px;height:15px}
input[type=text]{width:100%;height:52px;border-radius:14px;border:0;box-shadow:inset 0 0 0 1px var(--line);background:#fff;
  padding:0 16px;font:inherit;font-size:17px;color:var(--ink);outline:none}
input[type=text]:focus{box-shadow:inset 0 0 0 2px var(--ink)}
.styles{margin-top:12px;display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:520px){.styles{grid-template-columns:1fr 1fr}}
.styles button{height:84px;border:0;border-radius:16px;background:#FCFAF6;box-shadow:inset 0 0 0 1px var(--line);
  font-size:32px;color:var(--ink);cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 18px;text-align:left;
  transition:box-shadow .15s,background-color .15s}
.styles button[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--ink);background:rgba(245,184,46,.12)}
.save{margin-top:18px;width:100%;height:54px;border:0;border-radius:999px;background:var(--gold);color:var(--ink);
  font:inherit;font-weight:700;font-size:16.5px;cursor:pointer;box-shadow:inset 0 -2px 0 rgba(16,35,28,.12);transition:transform .15s,opacity .2s}
.save:active{transform:scale(.985)}
.save:disabled{opacity:.4;cursor:default;transform:none}
.msg{margin-top:12px;text-align:center;font-size:14.5px;min-height:22px}
.msg.ok{color:#2e8a55;font-weight:600}.msg.err{color:#c23b3b}
/* How it sits on a document: the corner of an invoice, with the signature
   above the line where it will print. */
.pv .k{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.sheet{margin-top:12px;border-radius:14px;background:#fff;box-shadow:0 0 0 1px var(--line),0 10px 24px -18px rgba(16,35,28,.4);
  padding:18px 20px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
.sheet .lines{flex:1;display:grid;gap:7px}
.sheet .lines i{display:block;height:7px;border-radius:9px;background:rgba(16,35,28,.07)}
.sheet .lines i:nth-child(2){width:70%}.sheet .lines i:nth-child(3){width:45%}
.sig{width:46%;max-width:210px}
.sig .space{height:64px;display:flex;align-items:flex-end;justify-content:flex-start}
.sig .space img{max-height:100%;max-width:100%;object-fit:contain;display:block;margin-bottom:-4px}
.sig .space span{font-size:12.5px;color:rgba(16,35,28,.35);padding-bottom:6px}
.sig .who{border-top:1px solid rgba(16,35,28,.5);padding-top:6px;font-size:11.5px;color:var(--faint)}
.current{display:flex;align-items:center;justify-content:space-between;gap:12px}
.current img{height:46px;max-width:60%;object-fit:contain}
.current p{font-size:12.5px;color:var(--faint);margin-top:2px}
.foot{margin-top:28px;display:flex;justify-content:center;opacity:.8}
`;

/*
 * Drawing: pointer events, a quadratic curve through the midpoints so a slow
 * finger does not leave corners, and a width that thins with speed like ink
 * does. Export trims to the ink and pads it, so the file is the signature and
 * none of the white around it.
 */
const JS = `
const $ = (s) => document.querySelector(s);
const INK = "#10231C";
const save = $("#save"), msg = $("#msg");
let mode = "draw", drawn = false, style = null;

function say(t, cls) { msg.textContent = t; msg.className = "msg " + (cls || ""); }
function ready() { save.disabled = mode === "draw" ? !drawn : !(style && $("#name").value.trim()); }

document.querySelectorAll(".tabs button").forEach((t) => t.addEventListener("click", () => {
  mode = t.dataset.mode;
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
  $("#draw").hidden = mode !== "draw"; $("#type").hidden = mode !== "type";
  say(""); ready(); preview();
}));

// Draw
const cv = $("#pad"), ctx = cv.getContext("2d");
/*
 * Sizes the canvas to its box, and only when the box really changed.
 *
 * Setting a canvas's width wipes it, and a phone fires "resize" whenever its
 * browser bar slides in or out, which a finger moving on the page does. So
 * every stroke on a phone was erased as it was drawn and the pad stayed
 * blank. Now an unchanged size is left alone, and a real change (turning the
 * phone) carries the drawing across.
 */
function fit() {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h || (w === cv.width && h === cv.height)) return;
  let keep = null;
  if (drawn) {
    keep = document.createElement("canvas"); keep.width = cv.width; keep.height = cv.height;
    keep.getContext("2d").drawImage(cv, 0, 0);
  }
  cv.width = w; cv.height = h;
  ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK;
  if (keep) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(keep, 0, 0, w, keep.height * (w / keep.width)); ctx.restore();
  } else { drawn = false; $("#hint").hidden = false; }
  ready();
}
let pts = [], last = 0;
function pos(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; }
cv.addEventListener("pointerdown", (e) => {
  // No scrolling, text selection or long-press menu while signing.
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  pts = [pos(e)]; last = 3.2; $("#hint").hidden = true;
});
cv.addEventListener("pointermove", (e) => {
  if (!pts.length) return;
  const p = pos(e), a = pts[pts.length - 1];
  const v = Math.hypot(p.x - a.x, p.y - a.y) / Math.max(1, p.t - a.t);
  const w = Math.max(1.4, Math.min(3.6, 3.8 - v * 1.3));
  last = last * 0.7 + w * 0.3;
  ctx.lineWidth = last;
  ctx.beginPath();
  if (pts.length > 1) {
    const b = pts[pts.length - 2];
    ctx.moveTo((b.x + a.x) / 2, (b.y + a.y) / 2);
    ctx.quadraticCurveTo(a.x, a.y, (a.x + p.x) / 2, (a.y + p.y) / 2);
  } else { ctx.moveTo(a.x, a.y); ctx.lineTo(p.x, p.y); }
  ctx.stroke(); pts.push(p); drawn = true; ready();
});
["pointerup", "pointercancel"].forEach((n) => cv.addEventListener(n, () => { pts = []; preview(); }));
$("#clear").addEventListener("click", () => {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
  drawn = false; $("#hint").hidden = false; ready(); preview();
});
window.addEventListener("resize", fit); fit();

/* The corner of an invoice under the pad shows the signature as it will
   print, redrawn whenever it changes. */
const pv = $("#pv");
async function preview() {
  if (!pv) return;
  let t = null;
  try { t = mode === "draw" ? (drawn ? trimmed(cv) : null) : (style && name.value.trim() ? trimmed(await typed()) : null); } catch (_) {}
  pv.innerHTML = "";
  if (t) { const i = document.createElement("img"); i.alt = ""; i.src = t.toDataURL("image/png"); pv.appendChild(i); }
  else { const sp = document.createElement("span"); sp.textContent = "Your signature here"; pv.appendChild(sp); }
}

// Type
const name = $("#name");
function paintStyles() {
  const v = name.value.trim() || "Your name";
  document.querySelectorAll(".styles button").forEach((b) => { b.textContent = v; });
  ready();
}
name.addEventListener("input", () => { paintStyles(); preview(); });
document.querySelectorAll(".styles button").forEach((b) => b.addEventListener("click", () => {
  style = b.dataset.font;
  document.querySelectorAll(".styles button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  ready(); preview();
}));
paintStyles();

// Trim a canvas to its ink, with a little room around it.
function trimmed(src) {
  const { width: w, height: h } = src, d = src.getContext("2d").getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(w, h) * 0.02);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext("2d").drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

async function typed() {
  const v = name.value.trim();
  await document.fonts.load('120px "' + style + '"', v);
  const c = document.createElement("canvas"), g = c.getContext("2d");
  g.font = '120px "' + style + '"';
  const m = g.measureText(v);
  c.width = Math.ceil(m.width + 160); c.height = 300;
  g.font = '120px "' + style + '"'; g.fillStyle = INK; g.textBaseline = "alphabetic";
  g.fillText(v, 80, 200);
  return c;
}

save.addEventListener("click", async () => {
  save.disabled = true; say("Saving…");
  try {
    const src = mode === "draw" ? cv : await typed();
    const t = trimmed(src);
    if (!t) { say("Draw your signature first.", "err"); ready(); return; }
    const res = await fetch(location.pathname, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ png: t.toDataURL("image/png") }),
    });
    if (!res.ok) throw new Error(String(res.status));
    say("Saved. It goes on your invoices and quotes from now on.", "ok");
    // Opened from settings: back there, which says it saved.
    setTimeout(() => (BACK ? location.assign(BACK + "?saved=signature") : location.reload()), 1200);
  } catch (e) { say("That did not save. Try again in a moment.", "err"); ready(); }
});

const rm = $("#remove");
if (rm) rm.addEventListener("click", async () => {
  const res = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove: true }) });
  if (res.ok) BACK ? location.assign(BACK + "?saved=signature") : location.reload();
});
`;

export function signaturePage(current: string | null, back: string | null = null): string {
  const fonts = STYLES.map((f) => `family=${f.replace(/ /g, "+")}`).join("&");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Your signature · Balans</title>
<link rel="stylesheet" href="/designs/fonts.css">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=swap">
<style>${CSS}</style></head>
<body>
<header class="top"><div class="in">
  ${back ? `<a class="back" href="${back}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Back to settings</a>` : ""}
  <div class="brand">${logoAvailable() ? markSvg("22px") : ""}balans</div>
  <h1>Your signature</h1>
  <p class="lead">It goes above your business name on your invoices and quotes. Documents without one simply leave the line off.</p>
</div></header>
<div class="wrap">
  ${
    current
      ? `<div class="card current"><div><img src="${current}" alt="Your signature"><p>On your documents now</p></div>
          <button class="link" id="remove" type="button">Remove it</button></div>`
      : ""
  }
  <div class="card">
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="draw" aria-selected="true"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 15.5c2.5-1 3.6-8.5 6-8.5 1.7 0-.3 6.3 1.2 6.3 1.1 0 1.6-2.2 2.6-2.2.8 0 .9 1.6 1.7 1.6.6 0 1.1-.6 1.5-1.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Draw</button>
      <button type="button" role="tab" data-mode="type" aria-selected="false"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5.5h12M10 5.5v10M7.5 15.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>Type</button>
    </div>
    <div class="pane" id="draw">
      <div class="pad"><canvas id="pad" aria-label="Draw your signature here"></canvas><span class="x">&times;</span><div class="base"></div>
        <div class="hint" id="hint">Sign here with your finger</div></div>
      <div class="row"><span>Take your time, then save.</span><button class="chip" id="clear" type="button"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Clear</button></div>
    </div>
    <div class="pane" id="type" hidden>
      <input type="text" id="name" maxlength="40" autocomplete="name" placeholder="Your name">
      <div class="styles">${STYLES.map((f) => `<button type="button" data-font="${esc(f)}" aria-pressed="false" style="font-family:'${esc(f)}',cursive"></button>`).join("")}</div>
    </div>
    <button class="save" id="save" type="button" disabled>Save signature</button>
    <p class="msg" id="msg" role="status"></p>
  </div>
  <div class="card pv">
    <p class="k">On your invoice</p>
    <div class="sheet">
      <div class="lines"><i></i><i></i><i></i></div>
      <div class="sig"><div class="space" id="pv"><span>Your signature here</span></div><div class="who">Authorised signature</div></div>
    </div>
  </div>
  <div class="foot">${logoAvailable() ? logoSvg("22px") : ""}</div>
</div><script>const BACK = ${JSON.stringify(back)};${JS}</script></body></html>`;
}

const gone = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Not found</title><link rel="stylesheet" href="/designs/fonts.css"><style>${CSS}</style></head>
<body><header class="top"><div class="in"><h1>Nothing here</h1>
<p class="lead">This link has expired. Reply <b>signature</b> on WhatsApp for a new one.</p></div></header></body></html>`;

export async function signatureRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string }; Querystring: { from?: string } }>("/signature/:token", async (req, reply) => {
    const owner = await ownerOfSignatureToken(req.params.token);
    if (!owner) return reply.status(404).type(HTML).send(gone());
    return reply
      .type(HTML)
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex, nofollow")
      .send(
        signaturePage(
          await signatureDataUri(owner.signatureUrl),
          req.query?.from === "settings" ? await liveSettingsPath(owner.id) : null,
        ),
      );
  });

  app.post<{ Params: { token: string }; Body: { png?: string; remove?: boolean } }>(
    "/signature/:token",
    // Base64 is four bytes for every three, plus the JSON around it.
    { bodyLimit: Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4096 },
    async (req, reply) => {
      const owner = await ownerOfSignatureToken(req.params.token);
      if (!owner) return reply.status(404).send({ ok: false });

      if (req.body?.remove === true) {
        await clearSignature(owner.id);
        req.log.info({ userId: owner.id }, "signature removed");
        return reply.send({ ok: true });
      }

      const saved = await saveSignature(owner.id, String(req.body?.png ?? ""));
      if (!saved.ok) {
        req.log.warn({ userId: owner.id, why: saved.why }, "signature refused");
        return reply.status(400).send({ ok: false, why: saved.why });
      }
      req.log.info({ userId: owner.id }, "signature saved");

      // Said in the chat too, where they came from and will go back to.
      void sendText(
        owner.phone,
        lines(
          `✍️ ${b("Signature saved.")}`,
          `It goes on your invoices and quotes from now on. Reply ${b("remove signature")} to take it off.`,
        ),
      ).catch(() => {});
      return reply.send({ ok: true });
    },
  );
}
