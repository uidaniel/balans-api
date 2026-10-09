/**
 * Choosing an invoice design (PRD F24).
 *
 * A web page rather than a WhatsApp list, because the whole point is seeing
 * them. A list of eight names tells somebody nothing about what their invoice
 * will look like.
 *
 * The previews are the real layouts rendered small, not pictures of them. One
 * definition, so a preview cannot drift from the document it promises — and
 * they are filled with the user's own business name and their most recent
 * client, because a layout looks different with your own words in it.
 *
 * The link is keyed on a secret belonging to the user, never on a document's
 * public token: a client holds that token, and a client must not be able to
 * restyle the invoices of the business billing them.
 */

import { liveSettingsPath } from "../../settings/page-token.ts";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { db } from "../../db/pool.ts";
import { addDays, todayIn } from "../../../core/dates.ts";
import { defaults } from "../../config.ts";
import { esc } from "../../documents/page.ts";
import { legalLines } from "../../documents/pdf.ts";
import { logoDataUri } from "../../brand/user-logo.ts";
import { renderDocumentHtml, type DocumentData } from "../../pdf/template.ts";
import { FONT, FONT_FILES, fontStylesheet } from "../../pdf/fonts.ts";
import { availableTo, renderTemplate, TEMPLATES, templateById } from "../../pdf/templates.ts";
import { logoSvg } from "../../brand/logo.ts";

const HTML = "text/html; charset=utf-8";

/** The user's own link to the picker, made on first use. */
export async function pickerUrlFor(userId: string, baseUrl: string): Promise<string> {
  const { rows } = await db().query<{ picker_token: string | null }>(
    `SELECT picker_token FROM users WHERE id = $1`,
    [userId],
  );

  let token = rows[0]?.picker_token ?? null;
  if (!token) {
    token = randomBytes(16).toString("hex");
    await db().query(`UPDATE users SET picker_token = $2 WHERE id = $1`, [userId, token]);
  }

  return `${baseUrl.replace(/\/$/, "")}/designs/${token}`;
}

type Owner = {
  id: string;
  businessName: string | null;
  email: string | null;
  address: string | null;
  tin: string | null;
  plan: "free" | "pro";
  templateId: string | null;
  logoUrl: string | null;
  brandColor: string | null;
};

async function ownerOf(token: string): Promise<Owner | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const { rows } = await db().query<{
    id: string;
    business_name: string | null;
    email: string | null;
    address: string | null;
    tin: string | null;
    plan: "free" | "pro";
    template_id: string | null;
    logo_url: string | null;
    brand_color: string | null;
  }>(
    `SELECT id, business_name, email, address, tin, plan, template_id, logo_url, brand_color
       FROM users WHERE picker_token = $1 AND status <> 'closed'`,
    [token],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        businessName: r.business_name,
        email: r.email,
        address: r.address,
        tin: r.tin,
        plan: r.plan,
        templateId: r.template_id,
        logoUrl: r.logo_url,
        brandColor: r.brand_color,
      }
    : null;
}

/**
 * A stand-in logo for the previews.
 *
 * The logo is the one Pro feature you cannot describe in a sentence — where
 * it sits, and how much room it takes, is the whole of it. A preview without
 * one shows a sheet that is not the sheet they would get.
 *
 * Drawn as an inline SVG rather than fetched, like everything else on these
 * sheets, and shown only on the Pro layouts: a Free user seeing it on Classic
 * would reasonably expect a logo they cannot have.
 */
const PLACEHOLDER_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMjAgNjQiPjxyZWN0IHg9IjEiIHk9IjEiIHdpZHRoPSIyMTgiIGhlaWdodD0iNjIiIHJ4PSIxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjQjlBRTk3IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1kYXNoYXJyYXk9IjcgNSIvPjxjaXJjbGUgY3g9IjQwIiBjeT0iMzIiIHI9IjEzIiBmaWxsPSJub25lIiBzdHJva2U9IiNCOUFFOTciIHN0cm9rZS13aWR0aD0iMiIvPjxwYXRoIGQ9Ik0zMyAzN2w2LTcgNSA1IDQtNCA1IDYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0I5QUU5NyIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48dGV4dCB4PSI2NiIgeT0iMjkiIGZvbnQtZmFtaWx5PSJTZWdvZSBVSSxBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjEzIiBmb250LXdlaWdodD0iNzAwIiBsZXR0ZXItc3BhY2luZz0iMS42IiBmaWxsPSIjOEE3RjZBIj5ZT1VSIExPR088L3RleHQ+PHRleHQgeD0iNjYiIHk9IjQ1IiBmb250LWZhbWlseT0iU2Vnb2UgVUksQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMC41IiBmaWxsPSIjQTk5Qzg0Ij5nb2VzIGhlcmUgb24gUHJvPC90ZXh0Pjwvc3ZnPg==";

/**
 * A believable invoice to preview with.
 *
 * Their own business name, and their most recent client if they have one. A
 * template previewed with somebody else's details is a template nobody can
 * picture using.
 */
async function sampleFor(owner: Owner): Promise<DocumentData> {
  // Their own logo when they have one, so the preview is the sheet they get.
  const mine = await logoDataUri(owner.id, owner.plan, owner.logoUrl);

  const { rows } = await db().query<{ name: string }>(
    `SELECT c.name FROM clients c
      WHERE c.user_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC LIMIT 1`,
    [owner.id],
  );

  const today = todayIn(defaults.behaviour.timezone);

  return {
    variant: "invoice",
    number: 14,
    businessName: owner.businessName ?? "Your business",
    businessEmail: owner.email,
    businessAddress: owner.address,
    businessTin: owner.tin,
    logoDataUri: mine,
    clientName: rows[0]?.name ?? "Zenith Homes",
    clientEmail: null,
    lines: [
      { description: "Exterior 3D render", qty: 1, unitAmountKobo: 250_000_00, amountKobo: 250_000_00 },
      { description: "Interior stills", qty: 4, unitAmountKobo: 20_000_00, amountKobo: 80_000_00 },
      { description: "Revision round", qty: 1, unitAmountKobo: 20_000_00, amountKobo: 20_000_00 },
    ],
    subtotalKobo: 350_000_00,
    vatKobo: 0,
    vatPercent: null,
    totalKobo: 350_000_00,
    amountPaidKobo: 0,
    issueDate: today,
    dueDate: addDays(today, 14),
    notes: null,
    publicUrl: "https://payment.balans.ng/i/…",
    legalLines: legalLines(owner.plan === "pro" ? { businessName: owner.businessName ?? "Your business" } : undefined),
    showMadeWith: owner.plan !== "pro",
    // Their colour on every preview, so the choice is made in it.
    brandColor: owner.plan === "pro" ? owner.brandColor : null,
  };
}

/* -------------------------------------------------------------------------- */

const CSS = `
/*
 * One number sizes the previews: --sc is how much of full size a sheet is
 * drawn at, and the frame, the card and the grid column all derive from it.
 * A sheet is 210x297mm, which is 793.7x1122.5px at 96dpi.
 */
:root{--marigold:#f5b82e;--ink:#10231c;--cream:#f6f1e7;--sand:#e9e1d0;--paper:#fff;
--muted:#5c6f66;--faint:#8a9a92;--line:rgba(16,35,28,.08);
--lift:0 0 0 1px rgba(16,35,28,.06),0 1px 2px rgba(16,35,28,.05),0 12px 32px -18px rgba(16,35,28,.2);
--sc:.28}
*{box-sizing:border-box;margin:0;padding:0}
/* Green the whole way down, so the white sheets are the brightest thing on
   the page and nothing competes with them. */
body{background:var(--ink);color:var(--ink);font-family:${FONT.sans};
-webkit-font-smoothing:antialiased;line-height:1.5;padding:0 0 80px}
.top{color:var(--cream);padding:22px 20px 28px}
.top .in,.wrap{max-width:1120px;margin:0 auto}
.back{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px 0 10px;border-radius:999px;
background:rgba(246,241,231,.08);color:var(--cream);font-weight:600;font-size:13.5px;text-decoration:none;margin-bottom:22px}
.back:hover{background:rgba(246,241,231,.14)}
.back svg{width:15px;height:15px;flex:none}
/* The page is set in the same two typefaces as the sheets it is offering. */
.top h1{font-family:${FONT.display};font-size:32px;line-height:1.1;letter-spacing:-.04em;font-weight:800}
.top p{margin-top:8px;color:rgba(246,241,231,.66);font-size:15px;max-width:56ch}
.now{display:inline-flex;align-items:center;gap:8px;margin-top:18px;padding:6px 12px 6px 8px;border-radius:999px;
background:rgba(246,241,231,.08);font-size:13px;color:rgba(246,241,231,.75)}
.now b{color:var(--cream);font-weight:600}
.now i{width:20px;height:20px;border-radius:50%;background:var(--marigold);display:grid;place-items:center}
.now i svg{width:11px;height:11px}
.wrap{padding:0 20px}
.bar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
/* All, Free, Pro: a segmented control, which only works with the script and
   is not drawn without it — every design is shown either way. */
.seg{display:none;padding:4px;border-radius:999px;background:rgba(246,241,231,.08);box-shadow:inset 0 0 0 1px rgba(246,241,231,.1)}
.js .seg{display:inline-flex}
.seg button{border:0;background:none;font:600 13.5px/1 ${FONT.sans};color:rgba(246,241,231,.7);height:34px;padding:0 14px;
border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background-color .2s,color .2s}
.seg button span{font-weight:500;opacity:.6;font-variant-numeric:tabular-nums}
.seg button[aria-pressed="true"]{background:var(--cream);color:var(--ink)}
/* The names, for jumping straight to one: only on a phone, where the
   designs are a row to swipe rather than a grid to scroll. */
.chips,.pos{display:none}
.done{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:13px 16px;border-radius:16px;
background:#eef7f1;color:#256b41;font-weight:600;font-size:14.5px;box-shadow:0 0 0 1px rgba(63,143,95,.2)}
.done::before{content:"";width:22px;height:22px;flex:none;border-radius:50%;background:#3f8f5f url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5 10 17.5 19 7.5'/%3E%3C/svg%3E") center/12px no-repeat}
.grid{display:grid;gap:18px;justify-content:center;grid-template-columns:repeat(auto-fill,calc(793.7px * var(--sc) + 24px))}
.card{background:var(--paper);border-radius:20px;box-shadow:0 20px 40px -24px rgba(0,0,0,.5);display:flex;flex-direction:column;
padding:12px;transition:box-shadow .25s,transform .25s}
.card:hover{transform:translateY(-2px);box-shadow:0 26px 50px -24px rgba(0,0,0,.6)}
.card.on{box-shadow:0 0 0 3px var(--marigold),0 20px 40px -24px rgba(0,0,0,.5)}
.card[hidden]{display:none}
/*
 * The preview is the real layout in an iframe, not a picture of it, so a
 * preview cannot promise a document the renderer would not produce. An iframe
 * rather than inlined markup because the sheet carries its own body rules,
 * which would otherwise land on this page; sandboxed because it is built from
 * names the user typed.
 */
.frame{position:relative;overflow:hidden;background:#fff;border-radius:10px;
box-shadow:0 0 0 1px var(--line),0 1px 3px rgba(16,35,28,.06);
width:calc(793.7px * var(--sc));height:calc(1122.5px * var(--sc))}
.frame iframe{position:absolute;top:0;left:0;width:793.7px;height:1122.5px;border:0;
transform:scale(var(--sc));transform-origin:top left;pointer-events:none}
.zoom{position:absolute;inset:0;border:0;background:transparent;cursor:zoom-in;display:flex;align-items:flex-end;
justify-content:flex-end;padding:10px}
.zoom span{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:999px;
background:rgba(16,35,28,.86);color:var(--cream);font:600 12px/1 ${FONT.sans};opacity:0;transform:translateY(4px);
transition:opacity .2s,transform .2s}
.card:hover .zoom span,.zoom:focus-visible span{opacity:1;transform:none}
.zoom:focus-visible{outline:2px solid var(--ink);outline-offset:-2px;border-radius:10px}
.lockchip{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;
border-radius:999px;background:var(--ink);color:var(--marigold);font:700 10.5px/1 ${FONT.sans};letter-spacing:.06em;text-transform:uppercase}
.lockchip svg{width:11px;height:11px}
.meta{padding:14px 4px 4px;display:flex;flex-direction:column;flex:1}
.name{font-weight:700;font-size:15.5px;display:flex;align-items:center;gap:8px}
.tag{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
padding:3px 7px;border-radius:99px;background:var(--sand);color:var(--muted)}
.tag.pro{background:var(--marigold);color:var(--ink)}
.blurb{margin-top:5px;font-size:13px;color:#6b7d74;line-height:1.45;flex:1}
form{margin-top:12px}
/* A pill, as every button on balans.ng is. */
.use{width:100%;height:42px;border:0;border-radius:999px;background:var(--ink);color:var(--cream);
font:600 14px/1 ${FONT.sans};cursor:pointer;transition:transform .15s,opacity .2s}
.use:hover{opacity:.9}
.use:active{transform:scale(.98)}
.use:disabled{background:#eef7f1;color:#256b41;cursor:default;opacity:1;transform:none}
.locked{margin-top:12px;padding:10px 12px;border-radius:14px;background:var(--cream);font-size:12.5px;color:var(--muted);text-align:center;line-height:1.45}
.locked b{color:var(--ink)}
.foot{display:block;width:max-content;margin:44px auto 0;opacity:.85;transition:opacity .2s}
.foot:hover{opacity:1}
.foot svg{display:block}
/* The large view: one sheet at reading size, stepped through with arrows. */
.lb{position:fixed;inset:0;z-index:20;display:none;background:rgba(16,35,28,.72);
-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px}
.lb.open{display:flex;animation:lbin .2s ease-out}
@keyframes lbin{from{opacity:0}}
.lbbox{display:flex;flex-direction:column;align-items:center;gap:14px;max-height:100%}
.lbsheet{position:relative;overflow:hidden;background:#fff;border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.4);
width:calc(793.7px * var(--lb));height:calc(1122.5px * var(--lb));animation:lbup .3s cubic-bezier(.16,1,.3,1)}
@keyframes lbup{from{transform:translateY(16px) scale(.98);opacity:0}}
.lbsheet iframe{position:absolute;top:0;left:0;width:793.7px;height:1122.5px;border:0;transform:scale(var(--lb));transform-origin:top left}
.lbbar{display:flex;align-items:center;gap:8px;color:var(--cream)}
.lbbar .t{min-width:9em;text-align:center;font-weight:600;font-size:14.5px}
.lbbar button{width:40px;height:40px;border:0;border-radius:999px;background:rgba(246,241,231,.12);color:var(--cream);
cursor:pointer;display:grid;place-items:center}
.lbbar button:hover{background:rgba(246,241,231,.2)}
.lbbar button svg{width:16px;height:16px}
@media(prefers-reduced-motion:reduce){.card,.lb.open,.lbsheet{animation:none;transition:none}}
/* On a phone, one design at a time, as big as the screen allows: a smudge of
   a sheet is not a choice anybody can make. Raising --sc is what drops the
   grid to one column. */
/*
 * On a phone: one design at a time, large, in a row you swipe, with the next
 * one peeking in from the edge so it is obvious there is more. Twenty cards
 * stacked was a scroll with no end and no sense of where you were in it; a
 * row of names above jumps straight to one, and a counter says where you are.
 * Without the script it is still a row that swipes, and every design can be
 * chosen from it.
 */
@media(max-width:560px){
  :root{--sc:.36}
  .top{padding:16px 16px 22px}
  .top h1{font-size:26px}
  .top p{font-size:14.5px}
  .wrap{padding:0}
  .bar{padding:0 12px;margin-bottom:12px}
  .done{margin:0 12px 14px}
  .js .chips{display:flex;gap:6px;overflow-x:auto;padding:2px 12px 12px;scrollbar-width:none;scroll-snap-type:x proximity}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:none;height:32px;padding:0 12px;border-radius:999px;border:0;background:rgba(246,241,231,.08);
    box-shadow:inset 0 0 0 1px rgba(246,241,231,.1);font:600 13px/1 ${FONT.sans};color:rgba(246,241,231,.75);display:inline-flex;align-items:center;gap:5px;scroll-snap-align:center}
  .chip i{width:6px;height:6px;border-radius:50%;background:var(--marigold)}
  .chip[aria-current="true"]{background:var(--cream);color:var(--ink);box-shadow:none}
  .chip[hidden]{display:none}
  .grid{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 12px 18px;
    scrollbar-width:none;-webkit-overflow-scrolling:touch;justify-content:flex-start;scroll-padding:0 12px}
  .grid::-webkit-scrollbar{display:none}
  .card{flex:none;width:calc(793.7px * var(--sc) + 24px);scroll-snap-align:center;scroll-snap-stop:always}
  .card:hover{transform:none}
  .js .pos{display:block;text-align:center;font-size:13px;color:rgba(246,241,231,.5);font-variant-numeric:tabular-nums;margin-top:-4px}
  .zoom span{opacity:1;transform:none}
  .name{font-size:16.5px}
  .blurb{font-size:13.5px}
  .use{height:48px;font-size:15.5px}
}
@media(min-width:400px) and (max-width:430px){:root{--sc:.4}}
@media(min-width:431px) and (max-width:560px){:root{--sc:.44}}
@media(min-width:561px) and (max-width:900px){:root{--sc:.3}}
`;

/**
 * One preview: the whole document, in a sandboxed iframe, scaled by CSS.
 *
 * `srcdoc` rather than a URL, so a page showing every layout is one request
 * and cannot half-load.
 *
 * Sandboxed, because the sheet is built from names the user typed: they are
 * escaped on the way in, and this means a mistake there still cannot run a
 * script, submit a form or navigate the page away.
 *
 * `allow-same-origin` is there because a fully opaque sandbox renders these
 * documents blank in Chrome — checked, not assumed. It gives back only the
 * origin, not scripting: without `allow-scripts` nothing in the frame runs,
 * and the pair together is the combination that would let a frame drop its
 * own sandbox, which is why they are not both here.
 */
function preview(html: string, title: string, locked = false): string {
  const doc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div class="frame">
      <iframe sandbox="allow-same-origin" loading="lazy" scrolling="no" tabindex="-1"
              title="${esc(title)} preview" srcdoc="${doc}"></iframe>
      ${locked ? `<span class="lockchip">${LOCK}Pro</span>` : ""}
      <button class="zoom" type="button" aria-label="See ${esc(title)} full size"><span>${EYE}Full size</span></button>
    </div>`;
}

/**
 * The Balans logo, coin and word, for the foot of a page that is green the
 * whole way down: the word is drawn in cream, and the coin keeps its own ink
 * mark on marigold.
 */
function logoOnInk(): string {
  const svg = logoSvg("30px");
  return svg ? svg.replace(/(<path transform[^>]*?)fill="#10231C"/, '$1fill="#F6F1E7"') : "balans.ng";
}

const LOCK = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.8" fill="currentColor"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" stroke="currentColor" stroke-width="1.6"/></svg>`;
const EYE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW = (d: string) => `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/*
 * The filter and the large view. Additive: without it every design is on the
 * page and each one can be chosen, which is all the page has to do.
 *
 * The large view makes its frame from the card's own srcdoc, so it shows the
 * same sheet — and makes it by createElement rather than markup, so there is
 * exactly one frame per design in what the server sends.
 */
const JS = `
document.documentElement.classList.add('js');
var cards = [].slice.call(document.querySelectorAll('.card'));
document.addEventListener('click', function (e) {
  var f = e.target.closest('.seg button');
  if (f) {
    var want = f.getAttribute('data-f');
    [].forEach.call(document.querySelectorAll('.seg button'), function (b) { b.setAttribute('aria-pressed', String(b === f)); });
    cards.forEach(function (c) { c.hidden = want !== 'all' && c.getAttribute('data-plan') !== want; });
    chips.forEach(function (c) { c.hidden = want !== 'all' && c.getAttribute('data-plan') !== want; });
    grid.scrollLeft = 0; track();
    return;
  }
  var g = e.target.closest('.chip');
  if (g) { go(+g.getAttribute('data-go'), true); return; }
  var z = e.target.closest('.zoom');
  if (z) { open(cards.indexOf(z.closest('.card'))); return; }
  if (e.target.closest('[data-lb="close"]') || e.target === lb) close();
  if (e.target.closest('[data-lb="prev"]')) step(-1);
  if (e.target.closest('[data-lb="next"]')) step(1);
});
var lb = document.getElementById('lb'), at = -1;
var grid = document.querySelector('.grid'), chips = [].slice.call(document.querySelectorAll('.chip'));
var pos = document.querySelector('.pos');
function swiping() { return getComputedStyle(grid).display === 'flex'; }
function go(i, smooth) {
  var c = cards[i]; if (!c || !swiping()) return;
  grid.scrollTo({ left: c.offsetLeft - (grid.clientWidth - c.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
}
/* Which card is in the middle: that one's name is lit and counted. */
function track() {
  if (!swiping()) return;
  var mid = grid.scrollLeft + grid.clientWidth / 2, list = shown(), best = 0, d = 1e9;
  list.forEach(function (c, k) { var x = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (x < d) { d = x; best = k; } });
  var i = cards.indexOf(list[best]);
  chips.forEach(function (c) {
    var on = +c.getAttribute('data-go') === i;
    if (on && c.getAttribute('aria-current') !== 'true') c.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    c.setAttribute('aria-current', String(on));
  });
  pos.textContent = (best + 1) + ' of ' + list.length;
}
var ticking = false;
grid.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; track(); }); } }, { passive: true });
var start = cards.findIndex(function (c) { return c.classList.contains('on'); });
go(start < 0 ? 0 : start, false); track();
function shown() { return cards.filter(function (c) { return !c.hidden; }); }
function size() {
  var s = Math.min((innerWidth - 32) / 793.7, (innerHeight - 110) / 1122.5, 1);
  lb.style.setProperty('--lb', s.toFixed(4));
}
function open(i) {
  at = i; size();
  var c = cards[i], src = c.querySelector('.frame iframe');
  var box = lb.querySelector('.lbsheet'); box.textContent = '';
  var f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-same-origin'); f.setAttribute('scrolling', 'no');
  f.title = src.title; f.srcdoc = src.srcdoc; box.appendChild(f);
  box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
  lb.querySelector('.t').textContent = c.getAttribute('data-name');
  lb.classList.add('open'); document.body.style.overflow = 'hidden';
  lb.querySelector('[data-lb="close"]').focus();
}
function close() { lb.classList.remove('open'); document.body.style.overflow = ''; at = -1; }
function step(d) {
  var list = shown(), k = list.indexOf(cards[at]);
  if (k < 0) return;
  open(cards.indexOf(list[(k + d + list.length) % list.length]));
}
addEventListener('keydown', function (e) {
  if (at < 0) return;
  if (e.key === 'Escape') close();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
addEventListener('resize', function () { if (at >= 0) size(); });
`;

/**
 * The page itself, built from data alone.
 *
 * Kept apart from the route so it can be checked without a database — what it
 * shows a Free user, and what it does not offer them, is the part worth a test.
 */
export function pickerPage(opts: {
  token: string;
  plan: "free" | "pro";
  chosenId: string | null;
  sample: DocumentData;
  savedId?: string | null;
  /** The settings page this was opened from, to go back to. */
  back?: string | null;
}): string {
  const chosen = templateById(opts.chosenId);
  const mine = new Set(availableTo(opts.plan).map((t) => t.id));
  const ready = TEMPLATES.filter((t) => t.ready);
  const free = ready.filter((t) => !t.pro).length;

  const cards = ready
    .map((t) => {
      /*
       * The stand-in goes on the Pro layouts only.
       *
       * Where the logo sits, and how much room it takes, is the whole of
       * that feature — a preview without one is not the sheet they would
       * get. It is left off the Free layouts because somebody on Free
       * seeing it there would reasonably expect a logo they cannot have.
       */
      const sample =
        t.pro && !opts.sample.logoDataUri
          ? { ...opts.sample, logoDataUri: PLACEHOLDER_LOGO }
          : opts.sample;

      /* `link` rather than embedded bytes: twenty sheets on one page would
         otherwise carry twenty copies of 400KB of typefaces, over a phone
         connection, to show the same files. */
      const html =
        renderTemplate(t.id, sample, { fonts: "link" }) ??
        renderDocumentHtml(sample, { fonts: "link" });
      const locked = !mine.has(t.id);
      const on = t.id === chosen.id;

      return `<div class="card${on ? " on" : ""}" data-plan="${t.pro ? "pro" : "free"}" data-name="${esc(t.name)}">
      ${preview(html, t.name, locked)}
      <div class="meta">
        <div class="name">${esc(t.name)}${
          t.pro ? `<span class="tag pro">Pro</span>` : `<span class="tag">Free</span>`
        }</div>
        <div class="blurb">${esc(t.blurb)}</div>
        ${
          locked
            ? `<div class="locked">Reply <b>upgrade</b> on WhatsApp<br>to use this one</div>`
            : `<form method="post" action="/designs/${esc(opts.token)}${opts.back ? "?from=settings" : ""}">
                 <input type="hidden" name="id" value="${esc(t.id)}">
                 <button class="use" type="submit"${on ? " disabled" : ""}>${on ? "Using this" : "Use this"}</button>
               </form>`
        }
      </div>
    </div>`;
    })
    .join("");

  const saved = opts.savedId ? templateById(opts.savedId) : null;
  const seg = (f: string, label: string, n: number, on = false) =>
    `<button type="button" data-f="${f}" aria-pressed="${on}">${label}<span>${n}</span></button>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice designs</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/designs/fonts.css">
<style>${CSS}</style></head><body>
<header class="top"><div class="in">
  ${opts.back ? `<a class="back" href="${esc(opts.back)}">${ARROW("M10 3.5 5.5 8l4.5 4.5")}Back to settings</a>` : ""}
  <h1>Your invoice design</h1>
  <p>Every one below is filled with your own details. Pick one and your next invoice
     uses it &mdash; the ones you have already sent do not change.</p>
  <p class="now"><i>${ARROW("M3.5 8.5 6.5 11.5 12.5 4.5")}</i>Current design <b>${esc(chosen.name)}</b></p>
</div></header>

<main class="wrap">
  ${saved ? `<div class="done" role="status">Saved. Your invoices now go out as ${esc(saved.name)}.</div>` : ""}
  <div class="bar">
    <div class="seg" role="group" aria-label="Show designs">
      ${seg("all", "All", ready.length, true)}${seg("free", "Free", free)}${seg("pro", "Pro", ready.length - free)}
    </div>
  </div>
  <div class="chips" role="tablist" aria-label="Designs">${ready
    .map(
      (t, i) =>
        `<button class="chip" type="button" data-go="${i}" data-plan="${t.pro ? "pro" : "free"}"${
          t.id === chosen.id ? ` aria-current="true"` : ""
        }>${t.id === chosen.id ? "<i></i>" : ""}${esc(t.name)}</button>`,
    )
    .join("")}</div>
  <div class="grid">${cards}</div>
  <p class="pos" aria-live="polite"></p>
</main>
<a class="foot" href="https://balans.ng" aria-label="Balans">${logoOnInk()}</a>

<div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Design, full size">
  <div class="lbbox">
    <div class="lbsheet"></div>
    <div class="lbbar">
      <button type="button" data-lb="prev" aria-label="Previous design">${ARROW("M10 3.5 5.5 8l4.5 4.5")}</button>
      <span class="t"></span>
      <button type="button" data-lb="next" aria-label="Next design">${ARROW("M6 3.5 10.5 8 6 12.5")}</button>
      <button type="button" data-lb="close" aria-label="Close">${ARROW("M4 4l8 8M12 4l-8 8")}</button>
    </div>
  </div>
</div>
<script>${JS}</script>
</body></html>`;
}

/* -------------------------------------------------------------------------- */

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  /*
   * The typefaces, for the previews.
   *
   * A PDF carries them in the HTML because it is rendered with no origin to
   * fetch from. This page has one, and eight sheets that would each carry
   * their own copy otherwise. Both are immutable: a font file is replaced by
   * adding another, never by editing this one.
   */
  app.get("/designs/fonts.css", async (_req, reply) =>
    reply
      .type("text/css; charset=utf-8")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(fontStylesheet()),
  );

  app.get<{ Params: { file: string } }>("/designs/fonts/:file", async (req, reply) => {
    // A fixed map, never a path joined from the request: this one reaches the
    // filesystem, and that is how a traversal bug gets written.
    const file = FONT_FILES[req.params.file];
    if (!file) return reply.status(404).send({ error: "not found" });

    return reply
      .type("font/ttf")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(await readFile(file));
  });

  app.get<{ Params: { token: string }; Querystring: { saved?: string; from?: string } }>(
    "/designs/:token",
    async (req, reply) => {
      const owner = await ownerOf(req.params.token);
      if (!owner) return reply.status(404).type(HTML).send(notFound());

      return reply
        .type(HTML)
        // A page keyed on a secret, so no cache between here and the phone
        // may keep a copy of it.
        .header("cache-control", "no-store, private")
        .header("x-robots-tag", "noindex")
        .send(
          pickerPage({
            token: req.params.token,
            plan: owner.plan,
            chosenId: owner.templateId,
            sample: await sampleFor(owner),
            savedId: req.query.saved ?? null,
            back: req.query.from === "settings" ? await liveSettingsPath(owner.id) : null,
          }),
        );
    },
  );

  app.post<{ Params: { token: string }; Body: Record<string, string>; Querystring: { from?: string } }>(
    "/designs/:token",
    async (req, reply) => {
      const owner = await ownerOf(req.params.token);
      if (!owner) return reply.status(404).type(HTML).send(notFound());

      const id = String((req.body as { id?: string })?.id ?? "");
      const spec = TEMPLATES.find((t) => t.id === id && t.ready);

      // A Free user cannot select a Pro layout by posting its id, whatever the
      // page showed them.
      if (!spec || (spec.pro && owner.plan !== "pro")) {
        req.log.warn({ userId: owner.id, id }, "template choice refused");
        return reply.redirect(`/designs/${req.params.token}`, 303);
      }

      await db().query(`UPDATE users SET template_id = $2 WHERE id = $1`, [owner.id, spec.id]);
      req.log.info({ userId: owner.id, template: spec.id }, "invoice design chosen");

      // Opened from settings: straight back there, which says it saved.
      const back = req.query?.from === "settings" ? await liveSettingsPath(owner.id) : null;
      if (back) return reply.redirect(`${back}?saved=design`, 303);

      // Redirect after the post, so a refresh does not send it again.
      return reply.redirect(`/designs/${req.params.token}?saved=${spec.id}`, 303);
    },
  );
}

const notFound = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/designs/fonts.css">
<style>${CSS}</style></head><body>
<header class="top"><div class="in"><h1>Nothing here</h1>
<p>This link has expired, or it was never quite right. Reply <b>designs</b> on WhatsApp for a new one.</p></div></header>
</body></html>`;
