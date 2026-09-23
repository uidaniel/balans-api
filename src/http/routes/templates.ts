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
  }>(
    `SELECT id, business_name, email, address, tin, plan, template_id, logo_url
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
    legalLines: legalLines(),
    showMadeWith: owner.plan !== "pro",
  };
}

/* -------------------------------------------------------------------------- */

const CSS = `
/*
 * One number sizes the previews: --sc is how much of full size a sheet is
 * drawn at, and the frame, the card and the grid column all derive from it.
 * A sheet is 210x297mm, which is 793.7x1122.5px at 96dpi.
 */
:root{--marigold:#f5b82e;--ink:#10231c;--cream:#f6f1e7;--sand:#e9e1d0;--sand2:#ddd3bf;--sc:.30}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:${FONT.sans};
-webkit-font-smoothing:antialiased;line-height:1.5;padding:28px 16px 72px}
.head{max-width:1000px;margin:0 auto 26px}
/* The page is set in the same two typefaces as the sheets it is offering. */
.head h1{font-family:${FONT.display};font-size:27px;letter-spacing:-.035em;font-weight:800}
.head p{margin-top:7px;color:#5c6f66;font-size:15px;max-width:52ch}
.grid{max-width:1000px;margin:0 auto;display:grid;gap:18px;justify-content:center;
grid-template-columns:repeat(auto-fill,calc(793.7px * var(--sc)))}
.card{background:#fff;border:1px solid var(--sand2);border-radius:16px;overflow:hidden;
display:flex;flex-direction:column}
.card.on{border-color:var(--ink);box-shadow:0 0 0 2px var(--ink)}
/*
 * The preview is the real layout in an iframe, not a picture of it, so a
 * preview cannot promise a document the renderer would not produce. An iframe
 * rather than inlined markup because the sheet carries its own body rules,
 * which would otherwise land on this page; sandboxed because it is built from
 * names the user typed.
 */
.frame{position:relative;overflow:hidden;background:#fff;border-bottom:1px solid #f0ece3;
width:calc(793.7px * var(--sc));height:calc(1122.5px * var(--sc))}
.frame iframe{position:absolute;top:0;left:0;width:793.7px;height:1122.5px;border:0;
transform:scale(var(--sc));transform-origin:top left}
.meta{padding:13px 15px 15px}
.name{font-weight:700;font-size:15.5px;display:flex;align-items:center;gap:7px}
.tag{font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
padding:2px 7px;border-radius:99px;background:var(--sand);color:#5c6f66}
.tag.pro{background:var(--marigold);color:var(--ink)}
.blurb{margin-top:5px;font-size:12.8px;color:#6b7d74;line-height:1.45;min-height:37px}
form{margin-top:11px}
/* A pill, as every button on balans.ng is. */
button{width:100%;padding:11px;border:0;border-radius:999px;background:var(--ink);color:var(--cream);
font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
button:disabled{background:var(--sand);color:#7d8d85;cursor:default}
.locked{margin-top:11px;font-size:12.5px;color:#8a9a92;text-align:center;line-height:1.4}
.done{max-width:1000px;margin:0 auto 20px;padding:13px 16px;border-radius:12px;
background:#e4f2e9;color:#256b41;font-weight:600;font-size:14.5px}
.foot{max-width:1000px;margin:32px auto 0;text-align:center;font-size:13px;color:#8a9a92}
/*
 * On a phone, one design at a time, as big as the screen allows.
 *
 * This was two columns, which fitted eight cards into less scrolling and made
 * every one of them unreadable — a 141px sheet is a grey smudge, and a picker
 * you cannot see is not a picker. Scrolling is cheap; deciding blind is not.
 *
 * Because the grid is auto-fill over a track sized from --sc, raising --sc is
 * what drops it to a single column: the track simply stops fitting twice. Two
 * steps, so the card is close to the full width on both a 320px phone and a
 * 430px one rather than stranded in the middle of either.
 */
@media(max-width:560px){
  :root{--sc:.45}
  body{padding:20px 12px 64px}
  .head{margin-bottom:20px}
  .head h1{font-size:23px}
  .head p{font-size:14.5px;margin-top:5px}
  .grid{gap:22px}
  /* The sheet is the point now, so it gets the room and the meta gets less. */
  .meta{padding:15px 16px 17px}
  .name{font-size:17px}
  .tag{font-size:10px}
  .blurb{font-size:13.5px;margin-top:6px;min-height:0}
  form{margin-top:14px}
  button{padding:14px;font-size:15.5px}
  .locked{margin-top:14px;font-size:13px}
  .done{font-size:14px;padding:12px 14px}
  .foot{margin-top:26px}
}

/* Narrow phones: a smaller sheet so the card still reaches both edges. */
@media(max-width:400px){
  :root{--sc:.375}
  body{padding:18px 10px 56px}
  .grid{gap:18px}
  .name{font-size:16px}
  .blurb{font-size:13px}
}

/* Larger phones: bigger again, rather than a card marooned in the middle. */
@media(min-width:431px) and (max-width:560px){
  :root{--sc:.50}
}

/* Between a phone and a desktop, two columns rather than one wide one. */
@media(min-width:561px) and (max-width:900px){
  :root{--sc:.30}
  .grid{gap:16px}
}
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
function preview(html: string, title: string): string {
  const doc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div class="frame">
      <iframe sandbox="allow-same-origin" loading="lazy" scrolling="no" tabindex="-1"
              title="${esc(title)} preview" srcdoc="${doc}"></iframe>
    </div>`;
}

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
}): string {
  const chosen = templateById(opts.chosenId);
  const mine = new Set(availableTo(opts.plan).map((t) => t.id));

  const cards = TEMPLATES.filter((t) => t.ready)
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

      /* `link` rather than embedded bytes: eight sheets on one page would
         otherwise carry eight copies of 400KB of typefaces, over a phone
         connection, to show the same eight files. */
      const html =
        renderTemplate(t.id, sample, { fonts: "link" }) ??
        renderDocumentHtml(sample, { fonts: "link" });
      const locked = !mine.has(t.id);
      const on = t.id === chosen.id;

      return `<div class="card${on ? " on" : ""}">
      ${preview(html, t.name)}
      <div class="meta">
        <div class="name">${esc(t.name)}${
          t.pro ? `<span class="tag pro">Pro</span>` : `<span class="tag">Free</span>`
        }</div>
        <div class="blurb">${esc(t.blurb)}</div>
        ${
          locked
            ? `<div class="locked">Reply <b>upgrade</b> on WhatsApp<br>to use this one</div>`
            : `<form method="post" action="/designs/${esc(opts.token)}">
                 <input type="hidden" name="id" value="${esc(t.id)}">
                 <button type="submit"${on ? " disabled" : ""}>${on ? "Using this" : "Use this"}</button>
               </form>`
        }
      </div>
    </div>`;
    })
    .join("");

  const saved = opts.savedId ? templateById(opts.savedId) : null;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice designs</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/designs/fonts.css">
<style>${CSS}</style></head><body>
${saved ? `<div class="done">Saved. Your invoices now go out as ${esc(saved.name)}.</div>` : ""}
<div class="head">
  <h1>Your invoice design</h1>
  <p>Every one below is filled with your own details. Pick one and your next invoice
     uses it &mdash; the ones you have already sent do not change.</p>
</div>
<div class="grid">${cards}</div>
<p class="foot">balans.ng</p>
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
      // Fonts are fetched under CORS. The emails ask for these from inside a
      // mail client, whose origin is never ours, and a face refused there
      // falls back silently to the system font.
      .header("access-control-allow-origin", "*")
      .send(await readFile(file));
  });

  app.get<{ Params: { token: string }; Querystring: { saved?: string } }>(
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
          }),
        );
    },
  );

  app.post<{ Params: { token: string }; Body: Record<string, string> }>(
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
<div class="head"><h1>Nothing here</h1>
<p>This link has expired, or it was never quite right. Reply <b>designs</b> on WhatsApp for a new one.</p></div>
</body></html>`;
