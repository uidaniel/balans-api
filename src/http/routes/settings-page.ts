/**
 * Settings, as a page opened from WhatsApp.
 *
 * "settings" in the chat used to be a list of rows, each starting its own
 * little conversation. Everything is now on one page instead, opened by a
 * button in the chat: the business's details, its brand (Pro), the invoice
 * defaults, the signature and design, the payout account and the plan. Each
 * section saves on its own, so a change to one never waits on another.
 *
 * The link is a stored token that lapses (settings/page-token.ts). Changing
 * the payout account also needs the code emailed to the verified address,
 * exactly as it does in the chat, and raises the same security alert —
 * `finishChange` is the one path for both.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { env, defaults } from "../../config.ts";
import { db } from "../../db/pool.ts";
import { addDays, todayIn } from "../../../core/dates.ts";
import { esc } from "../../documents/page.ts";
import { legalLines } from "../../documents/pdf.ts";
import { ownerOfSettingsToken } from "../../settings/page-token.ts";
import { accountInForce } from "../../settings/bank-change.ts";
import { setBusinessName } from "../../conversation/store.ts";
import { clearLogo, logoDataUri, MAX_LOGO_BYTES, saveLogoBytes } from "../../brand/user-logo.ts";
import { get as getFile } from "../../storage/files.ts";
import { normaliseHex } from "../../brand/colour.ts";
import { renderDocumentHtml, type DocumentData } from "../../pdf/template.ts";
import { FONT } from "../../pdf/fonts.ts";
import { renderTemplate, TEMPLATES } from "../../pdf/templates.ts";
import { pickerUrlFor } from "./templates.ts";
import { issueSignatureToken } from "../../brand/signature.ts";
import { proStartUrl } from "../../billing/pro-link.ts";
import { renewalOpen, stateOf } from "../../billing/subscription.ts";
import { cachedBanks } from "../../payments/paystack.ts";
import { checkAccount } from "../../payments/bank-directory.ts";
import { finishChange, sendChangeCode } from "../../whatsapp/flows/actions.ts";

const HTML = "text/html; charset=utf-8";
const base = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");

type Row = {
  business_name: string | null;
  email: string | null;
  email_verified: boolean;
  address: string | null;
  tin: string | null;
  plan: "free" | "pro";
  logo_url: string | null;
  brand_color: string | null;
  signature_url: string | null;
  default_due_days: number | null;
  invoice_number_start: number;
  template_id: string | null;
  next_number: number;
  payment_details: string | null;
  abroad_pay_by: "link" | "own";
};

async function load(userId: string): Promise<Row> {
  const { rows } = await db().query<Row>(
    `SELECT u.business_name, u.email, u.email_verified_at IS NOT NULL AS email_verified, u.address, u.tin,
            u.plan, u.logo_url, u.brand_color, u.signature_url, u.default_due_days,
            u.invoice_number_start, u.template_id, u.payment_details, u.abroad_pay_by,
            GREATEST(
              COALESCE((SELECT MAX(d.number) FROM documents d WHERE d.user_id = u.id AND d.type <> 'sample'), 0) + 1,
              u.invoice_number_start
            )::int AS next_number
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return rows[0]!;
}

/** Everything the page shows, in one read. */
async function state(userId: string) {
  const [u, account, sub, designs, signature] = await Promise.all([
    load(userId),
    accountInForce(userId),
    stateOf(userId),
    pickerUrlFor(userId, base()),
    issueSignatureToken(userId),
  ]);
  const design = TEMPLATES.find((t) => t.id === u.template_id) ?? TEMPLATES[0]!;
  return {
    plan: sub.plan,
    proUntil: sub.plan === "pro" ? (sub.periodEnd?.toISOString() ?? null) : null,
    inGrace: sub.inGrace,
    canRenew: renewalOpen(sub),
    business: {
      name: u.business_name ?? "",
      email: u.email,
      emailVerified: u.email_verified,
      address: u.address ?? "",
      tin: u.tin ?? "",
    },
    brand: { logo: Boolean(u.logo_url), colour: u.brand_color },
    signature: Boolean(u.signature_url),
    invoices: {
      dueDays: u.default_due_days ?? defaults.behaviour.defaultDueDays,
      nextNumber: u.next_number,
      design: design.name,
    },
    abroad: { details: u.payment_details ?? "", payBy: u.abroad_pay_by },
    bank: account ? { bankName: account.bankName, last4: account.last4, accountName: account.accountName } : null,
    links: {
      designs,
      signature: `${base()}/signature/${signature}`,
      pro: proStartUrl(userId),
    },
  };
}

/** A sample invoice in their design, name, logo and colour, for the preview. */
async function preview(userId: string, overrides: { colour?: string | null; name?: string }): Promise<string> {
  const u = await load(userId);
  const pro = u.plan === "pro";
  const today = todayIn(defaults.behaviour.timezone);
  const name = (overrides.name ?? u.business_name ?? "").trim() || "Your business";
  const d: DocumentData = {
    variant: "invoice",
    number: String(u.next_number).padStart(4, "0"),
    businessName: name,
    businessEmail: u.email,
    businessAddress: u.address,
    businessTin: u.tin,
    logoDataUri: await logoDataUri(userId, u.plan, u.logo_url),
    clientName: "Zenith Homes",
    clientEmail: null,
    lines: [
      { description: "Exterior 3D render", qty: 1, unitAmountKobo: 250_000_00, amountKobo: 250_000_00 },
      { description: "Interior stills", qty: 4, unitAmountKobo: 20_000_00, amountKobo: 80_000_00 },
    ],
    subtotalKobo: 330_000_00,
    vatKobo: 0,
    vatPercent: null,
    totalKobo: 330_000_00,
    amountPaidKobo: 0,
    issueDate: today,
    dueDate: addDays(today, u.default_due_days ?? defaults.behaviour.defaultDueDays),
    notes: null,
    publicUrl: `${base()}/i/…`,
    legalLines: legalLines(pro ? { businessName: name } : undefined),
    showMadeWith: !pro,
    brandColor: pro ? (overrides.colour !== undefined ? overrides.colour : u.brand_color) : null,
  } as DocumentData;
  const template = pro || !TEMPLATES.find((t) => t.id === u.template_id)?.pro ? u.template_id : null;
  return renderTemplate(template, d, { fonts: "link" }) ?? renderDocumentHtml(d, { fonts: "link" });
}

const nope = (reply: FastifyReply, message: string, status = 400) => reply.status(status).send({ ok: false, message });

export async function settingsPageRoutes(app: FastifyInstance): Promise<void> {
  // Every route below starts by finding whose token this is.
  const who = async (token: string) => ownerOfSettingsToken(token);

  app.get<{ Params: { token: string } }>("/settings/:token", async (req, reply) => {
    const owner = await who(req.params.token);
    const r = reply
      .type(HTML)
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex, nofollow");
    if (!owner) return r.status(404).send(gonePage());
    return r.send(settingsPage(req.params.token));
  });

  app.get<{ Params: { token: string } }>("/settings/:token/state", async (req, reply) => {
    const owner = await who(req.params.token);
    if (!owner) return nope(reply, "This link has expired. Reply settings on WhatsApp for a new one.", 404);
    return reply.header("cache-control", "no-store").send({ ok: true, ...(await state(owner.id)) });
  });

  /* -- Business ----------------------------------------------------------- */
  app.post<{ Params: { token: string }; Body: { name?: string; address?: string; tin?: string } }>(
    "/settings/:token/business",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const name = String(req.body?.name ?? "").trim();
      const address = String(req.body?.address ?? "").trim().slice(0, 200);
      const tin = String(req.body?.tin ?? "").trim().slice(0, 30);
      if (name.length < 2 || name.length > 80) return nope(reply, "Give a business name between 2 and 80 characters.");
      await setBusinessName(owner.id, name);
      await db().query(`UPDATE users SET address = NULLIF($2, ''), tin = NULLIF($3, '') WHERE id = $1`, [
        owner.id,
        address,
        tin,
      ]);
      req.log.info({ userId: owner.id }, "settings page: business details saved");
      return { ok: true };
    },
  );

  /* -- Clients abroad ----------------------------------------------------- */
  app.post<{ Params: { token: string }; Body: { details?: string; payBy?: string } }>(
    "/settings/:token/abroad",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const details = String(req.body?.details ?? "").replace(/\r\n?/g, "\n").trim();
      const payBy = req.body?.payBy === "own" ? "own" : "link";
      if (details.length > 600) return nope(reply, "Keep your payment details under 600 characters.");
      if (payBy === "own" && !details) return nope(reply, "Add your payment details first, or keep the payment link.");
      await db().query(`UPDATE users SET payment_details = NULLIF($2, ''), abroad_pay_by = $3 WHERE id = $1`, [
        owner.id,
        details,
        payBy,
      ]);
      req.log.info({ userId: owner.id, payBy }, "settings page: payment details saved");
      return { ok: true };
    },
  );

  /* -- Invoices ----------------------------------------------------------- */
  app.post<{ Params: { token: string }; Body: { dueDays?: number; nextNumber?: number } }>(
    "/settings/:token/invoices",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const days = Number(req.body?.dueDays);
      const start = Number(req.body?.nextNumber);
      if (!Number.isInteger(days) || days < 0 || days > 180) return nope(reply, "Days to pay must be 0 to 180.");
      if (!Number.isInteger(start) || start < 1 || start > 2_000_000_000) return nope(reply, "Give a whole number from 1.");
      await db().query(`UPDATE users SET default_due_days = $2, invoice_number_start = $3 WHERE id = $1`, [
        owner.id,
        days,
        start,
      ]);
      // Numbers only go forward: say what the next one really is.
      const next = (await load(owner.id)).next_number;
      return {
        ok: true,
        nextNumber: next,
        note: next !== start ? `You have already issued past #${start}, so the next invoice is #${next}.` : null,
      };
    },
  );

  /* -- Brand (Pro) -------------------------------------------------------- */
  app.post<{ Params: { token: string }; Body: { colour?: string | null } }>(
    "/settings/:token/brand",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      if ((await load(owner.id)).plan !== "pro") return nope(reply, "Brand colours are part of Pro.", 403);
      const raw = req.body?.colour;
      const colour = raw === null || raw === "" ? null : normaliseHex(raw);
      if (raw && !colour) return nope(reply, "That is not a colour. Use a hex code like #1A73E8.");
      await db().query(`UPDATE users SET brand_color = $2 WHERE id = $1`, [owner.id, colour]);
      req.log.info({ userId: owner.id, colour }, "settings page: brand colour saved");
      return { ok: true, colour };
    },
  );

  app.post<{ Params: { token: string }; Body: { image?: string; remove?: boolean } }>(
    "/settings/:token/logo",
    // Base64 is four bytes for every three, plus the JSON around it.
    { bodyLimit: Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 4096 },
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      if ((await load(owner.id)).plan !== "pro") return nope(reply, "Your logo on invoices is part of Pro.", 403);
      if (req.body?.remove === true) {
        await clearLogo(owner.id);
        return { ok: true };
      }
      const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image ?? ""));
      if (!m) return nope(reply, "Choose a PNG, JPEG or WebP picture.");
      const saved = await saveLogoBytes(owner.id, Buffer.from(m[1]!, "base64"), req.log);
      if (!saved.ok) {
        return nope(
          reply,
          saved.why === "too_large" ? "That picture is over 2 MB. Try a smaller one." : "Choose a PNG, JPEG or WebP picture.",
        );
      }
      return { ok: true };
    },
  );

  // The logo itself, same-origin, so the page can read its colours.
  app.get<{ Params: { token: string } }>("/settings/:token/logo", async (req, reply) => {
    const owner = await who(req.params.token);
    if (!owner) return reply.status(404).send();
    const u = await load(owner.id);
    const file = u.logo_url ? await getFile(u.logo_url).catch(() => null) : null;
    if (!file) return reply.status(404).send();
    return reply.type(file.contentType).header("cache-control", "no-store, private").send(file.bytes);
  });

  app.get<{ Params: { token: string }; Querystring: { colour?: string; name?: string } }>(
    "/settings/:token/preview",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return reply.status(404).type(HTML).send("");
      const q = req.query ?? {};
      const html = await preview(owner.id, {
        ...(q.colour !== undefined ? { colour: q.colour === "" ? null : normaliseHex(q.colour) } : {}),
        ...(q.name !== undefined ? { name: String(q.name).slice(0, 80) } : {}),
      });
      return reply.type(HTML).header("cache-control", "no-store, private").send(html);
    },
  );

  /* -- Payout account ----------------------------------------------------- */
  app.get<{ Params: { token: string } }>("/settings/:token/banks", async (req, reply) => {
    const owner = await who(req.params.token);
    if (!owner) return nope(reply, "This link has expired.", 404);
    const banks = await cachedBanks();
    return { ok: true, banks: banks.map((b) => ({ name: b.name, code: b.code })) };
  });

  app.post<{ Params: { token: string }; Body: { bankCode?: string; accountNumber?: string } }>(
    "/settings/:token/bank/check",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const accountNumber = String(req.body?.accountNumber ?? "").replace(/\D/g, "");
      if (accountNumber.length !== 10) return nope(reply, "An account number is 10 digits.");
      const bank = (await cachedBanks()).find((b) => b.code === String(req.body?.bankCode ?? ""));
      if (!bank) return nope(reply, "Choose your bank from the list.");
      const checked = await checkAccount(accountNumber, bank);
      if (!checked.ok) {
        return nope(
          reply,
          checked.reason === "invalid_details"
            ? "The bank does not know that account number. Check it and try again."
            : "We could not reach the bank just now. Try again in a minute.",
        );
      }
      return { ok: true, accountName: checked.account.accountName, bankName: bank.name };
    },
  );

  app.post<{ Params: { token: string } }>("/settings/:token/bank/code", async (req, reply) => {
    const owner = await who(req.params.token);
    if (!owner) return nope(reply, "This link has expired.", 404);
    const sent = await sendChangeCode(owner.id, req.log);
    if (!sent.ok) return nope(reply, sent.message);
    const [name, domain] = sent.email.split("@");
    return { ok: true, to: `${name?.[0] ?? ""}***@${domain ?? ""}` };
  });

  app.post<{ Params: { token: string }; Body: { bankCode?: string; accountNumber?: string; code?: string } }>(
    "/settings/:token/bank/confirm",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const accountNumber = String(req.body?.accountNumber ?? "").replace(/\D/g, "");
      const code = String(req.body?.code ?? "").replace(/\D/g, "");
      const bank = (await cachedBanks()).find((b) => b.code === String(req.body?.bankCode ?? ""));
      if (!bank || accountNumber.length !== 10) return nope(reply, "Check the bank and account number again.");
      if (code.length !== 6) return nope(reply, "The code is 6 digits, from the email we just sent.");
      // Asked of the bank again here, not taken from the page: the name that
      // goes on invoices is the one the bank gives, not one sent to us.
      const checked = await checkAccount(accountNumber, bank);
      if (!checked.ok) return nope(reply, "The bank did not confirm that account. Nothing was changed.");
      const done = await finishChange(
        owner.id,
        code,
        { bankCode: bank.code, bankName: bank.name, accountNumber, accountName: checked.account.accountName },
        req.log,
      );
      if (!done.ok) return nope(reply, done.message);
      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

const CSS = `
:root{--marigold:#f5b82e;--ink:#10231c;--cream:#f6f1e7;--sand:#e9e1d0;--paper:#fffdf8;--line:#e4dccb;
--muted:#5f6f67;--faint:#8a978f;--moss:#2f7a4b;--clay:#b8452d}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:${FONT.sans};-webkit-font-smoothing:antialiased;
line-height:1.5;padding:20px 14px 60px}
.wrap{max-width:560px;margin:0 auto}
h1{font-family:${FONT.display};font-size:26px;font-weight:800;letter-spacing:-.035em;line-height:1.1}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.sub{color:var(--muted);font-size:14px;margin-bottom:18px}
.pill{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:99px;
background:var(--sand);color:var(--muted);white-space:nowrap}
.pill.pro{background:var(--ink);color:var(--marigold)}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:18px;margin-top:14px}
.card h2{font-family:${FONT.display};font-size:17px;font-weight:700;letter-spacing:-.02em}
.card .hint{color:var(--muted);font-size:13.5px;margin-top:2px}
label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-top:14px}
input,select{width:100%;margin-top:5px;height:46px;border:1px solid var(--line);border-radius:12px;background:#fff;
padding:0 13px;font:inherit;font-size:16px;color:var(--ink);outline:none}
input:focus,select:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(16,35,28,.08)}
input[readonly]{background:var(--cream);color:var(--muted)}
textarea{width:100%;margin-top:5px;min-height:110px;border:1px solid var(--line);border-radius:12px;background:#fff;
padding:11px 13px;font:inherit;font-size:16px;line-height:1.45;color:var(--ink);outline:none;resize:vertical}
textarea:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(16,35,28,.08)}
.row{display:flex;gap:10px}.row>*{flex:1}
button{cursor:pointer;font:inherit}
.btn{margin-top:16px;width:100%;height:48px;border:0;border-radius:999px;background:var(--ink);color:var(--cream);
font-weight:600;font-size:15px}
.btn.gold{background:var(--marigold);color:var(--ink)}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.link{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-top:1px solid var(--line);
color:var(--ink);text-decoration:none;font-weight:600;font-size:15px}
.link:first-of-type{border-top:0}
.link small{display:block;font-weight:400;color:var(--muted);font-size:13px}
.link .go{color:var(--faint);font-size:20px}
.msg{margin-top:10px;font-size:13.5px;min-height:1px}
.msg.ok{color:var(--moss)}.msg.err{color:var(--clay)}
.logo{display:flex;align-items:center;gap:14px;margin-top:12px}
.logo .box{width:84px;height:84px;border-radius:14px;border:1px dashed var(--line);background:#fff;display:grid;
place-items:center;overflow:hidden;flex:none}
.logo .box img{max-width:100%;max-height:100%;object-fit:contain}
.logo .box span{font-size:11px;color:var(--faint);text-align:center;padding:6px}
.logo .acts{display:flex;flex-direction:column;gap:8px;flex:1}
.logo .acts .btn{margin-top:0;height:42px}
.swatches{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.sw{width:40px;height:40px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px var(--line)}
.sw.on{box-shadow:0 0 0 2px var(--ink)}
.pick{display:flex;gap:10px;align-items:center;margin-top:12px}
.pick input[type=color]{width:56px;height:46px;padding:4px;flex:none}
.frame{margin-top:14px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;position:relative;
height:calc(1122.5px * var(--sc));--sc:.42}
.frame iframe{position:absolute;top:0;left:0;width:793.7px;height:1122.5px;border:0;transform:scale(var(--sc));
transform-origin:top left}
.locked{margin-top:10px;padding:14px;border-radius:14px;background:var(--cream);font-size:14px;color:var(--muted)}
.bank{margin-top:10px;padding:14px;border-radius:14px;background:var(--cream)}
.bank b{display:block;font-size:15.5px}
.bank span{color:var(--muted);font-size:13.5px}
.found{margin-top:12px;padding:12px 14px;border-radius:12px;background:#e6f2ea;color:var(--moss);font-weight:600}
.hidden{display:none}
.saved{margin-top:4px;padding:12px 14px;border-radius:12px;background:#e6f2ea;color:var(--moss);font-weight:600;font-size:14.5px}
.foot{margin-top:22px;text-align:center;color:var(--faint);font-size:12.5px}
`;

const JS = `
const T = location.pathname.split('/')[2];
const $ = (id) => document.getElementById(id);
const api = async (path, body, method) => {
  const res = await fetch('/settings/' + T + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {}; try { json = await res.json(); } catch (e) {}
  if (!res.ok || json.ok === false) throw new Error(json.message || 'Something went wrong. Try again.');
  return json;
};
const say = (id, text, ok) => { const el = $(id); el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };
let S = null;

function fill() {
  $('title').textContent = S.business.name || 'Your settings';
  $('plan').textContent = S.plan === 'pro' ? 'Pro' : 'Free';
  $('plan').className = 'pill' + (S.plan === 'pro' ? ' pro' : '');
  $('b-name').value = S.business.name; $('b-address').value = S.business.address; $('b-tin').value = S.business.tin;
  $('b-email').value = S.business.email ? S.business.email + (S.business.emailVerified ? '' : ' (not verified)') : 'None';
  $('i-days').value = S.invoices.dueDays; $('i-next').value = S.invoices.nextNumber;
  $('a-details').value = S.abroad.details; $('a-payby').value = S.abroad.payBy;
  $('l-design').querySelector('small').textContent = S.invoices.design;
  $('l-design').href = S.links.designs + '?from=settings';
  $('l-sign').href = S.links.signature + '?from=settings';
  $('l-sign').querySelector('small').textContent = S.signature ? 'On your invoices' : 'None yet';
  $('bank-now').innerHTML = S.bank
    ? '<b></b><span></span>'
    : '<span>No payout account yet.</span>';
  if (S.bank) {
    $('bank-now').querySelector('b').textContent = S.bank.accountName;
    $('bank-now').querySelector('span').textContent = S.bank.bankName + ' \\u2022\\u2022' + S.bank.last4;
  }
  const pro = S.plan === 'pro';
  $('brand-pro').classList.toggle('hidden', !pro);
  $('brand-free').classList.toggle('hidden', pro);
  $('brand-up').href = S.links.pro;
  const until = S.proUntil ? new Date(S.proUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  $('plan-text').textContent = pro
    ? (S.inGrace ? 'Your Pro month has ended. You keep Pro until the end of the grace week.' : 'Pro until ' + until + '.')
    : 'Free: 3 invoices a month.';
  $('plan-btn').classList.toggle('hidden', pro && !S.canRenew);
  $('plan-btn').href = S.links.pro;
  $('plan-btn').textContent = pro ? 'Renew Pro' : 'Upgrade to Pro';
  if (pro) { showLogo(); pickColour(S.brand.colour || '', false); }
  snapshot();
}

/*
 * A Save button is live only while its section differs from what is saved.
 * Nothing to save looks like nothing to save, and a tap cannot send the same
 * values twice.
 */
let saved = {};
const val = (id) => $(id).value.trim();
function snapshot() {
  saved = {
    b: [val('b-name'), val('b-address'), val('b-tin')].join('\u0000'),
    i: [val('i-days'), val('i-next')].join('\u0000'),
    a: [val('a-details'), $('a-payby').value].join('\u0000'),
  };
  dirty();
}
function dirty() {
  $('b-save').disabled = !val('b-name') || [val('b-name'), val('b-address'), val('b-tin')].join('\u0000') === saved.b;
  $('a-save').disabled = [val('a-details'), $('a-payby').value].join('\u0000') === saved.a
    || ($('a-payby').value === 'own' && !val('a-details'));
  $('i-save').disabled = val('i-days') === '' || val('i-next') === '' || [val('i-days'), val('i-next')].join('\u0000') === saved.i;
  if (S && S.plan === 'pro') {
    $('c-save').disabled = colour === (S.brand.colour || '');
    $('c-reset').disabled = !S.brand.colour && !colour;
  }
  const bank = $('k-bank').value, num = $('k-number').value.replace(/\D/g, '');
  $('k-check').disabled = !bank || num.length !== 10;
  $('k-confirm').disabled = !checked || $('k-code').value.replace(/\D/g, '').length !== 6;
}
['b-name', 'b-address', 'b-tin', 'i-days', 'i-next', 'a-details', 'k-number', 'k-code'].forEach((id) => $(id).addEventListener('input', dirty));
$('a-payby').addEventListener('change', dirty);
$('k-bank').addEventListener('change', () => { checked = null; $('k-found').classList.add('hidden'); $('k-verify').classList.add('hidden'); dirty(); });
$('k-number').addEventListener('input', () => { if (checked) { checked = null; $('k-found').classList.add('hidden'); $('k-verify').classList.add('hidden'); } });

/* Business */
$('b-save').onclick = async (e) => {
  busy(e.target, true, 'Saving\\u2026');
  try {
    await api('/business', { name: $('b-name').value, address: $('b-address').value, tin: $('b-tin').value });
    S.business.name = $('b-name').value.trim(); $('title').textContent = S.business.name;
    say('b-msg', 'Saved.', true); refreshPreview();
    busy(e.target, false, 'Save details'); snapshot();
  } catch (err) { say('b-msg', err.message); busy(e.target, false, 'Save details'); dirty(); }
};

/* Invoices */
$('i-save').onclick = async (e) => {
  busy(e.target, true, 'Saving\\u2026');
  try {
    const r = await api('/invoices', { dueDays: Number($('i-days').value), nextNumber: Number($('i-next').value) });
    $('i-next').value = r.nextNumber; say('i-msg', r.note || 'Saved.', true);
    busy(e.target, false, 'Save'); snapshot();
  } catch (err) { say('i-msg', err.message); busy(e.target, false, 'Save'); dirty(); }
};

/* Clients abroad */
$('a-save').onclick = async (e) => {
  busy(e.target, true, 'Saving\u2026');
  try {
    await api('/abroad', { details: $('a-details').value, payBy: $('a-payby').value });
    S.abroad = { details: val('a-details'), payBy: $('a-payby').value };
    say('a-msg', 'Saved. Your next invoices abroad use it.', true);
    busy(e.target, false, 'Save'); snapshot();
  } catch (err) { say('a-msg', err.message); busy(e.target, false, 'Save'); dirty(); }
};

/* Brand: logo */
function showLogo() {
  const box = $('logo-box');
  if (S.brand.logo) {
    box.innerHTML = '<img alt="Your logo">';
    const img = box.querySelector('img');
    img.onload = () => swatchesFrom(img);
    img.src = '/settings/' + T + '/logo?' + Date.now();
    $('logo-remove').classList.remove('hidden');
  } else {
    box.innerHTML = '<span>No logo yet</span>';
    $('logo-remove').classList.add('hidden');
    $('swatches').innerHTML = '';
  }
}
$('logo-file').onchange = async () => {
  const f = $('logo-file').files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) return say('logo-msg', 'That picture is over 2 MB. Try a smaller one.');
  const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
  say('logo-msg', 'Uploading\\u2026', true);
  try {
    await api('/logo', { image: data });
    S.brand.logo = true; showLogo(); say('logo-msg', 'Logo saved. Pick a colour from it below.', true); refreshPreview();
  } catch (err) { say('logo-msg', err.message); }
  $('logo-file').value = '';
};
$('logo-remove').onclick = async () => {
  try { await api('/logo', { remove: true }); S.brand.logo = false; showLogo(); say('logo-msg', 'Logo removed.', true); refreshPreview(); }
  catch (err) { say('logo-msg', err.message); }
};

/* Brand: colours from the logo. Counts pixels in coarse buckets, leaves out
   the near-white and near-black a logo sits on, and ranks the rest by how
   much of the logo they cover and how vivid they are. */
function swatchesFrom(img) {
  try {
    const c = document.createElement('canvas'); const n = 64; c.width = n; c.height = n;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, n, n);
    const px = x.getImageData(0, 0, n, n).data; const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 510;
      if (l > 0.94 || l < 0.05) continue;
      const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
      const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b; buckets.set(k, e);
    }
    // A colour has to cover some of the logo to count: the blends a resize
    // makes along every edge are real pixels, but nobody chose them.
    const total = [...buckets.values()].reduce((t, e) => t + e.n, 0);
    const list = [...buckets.values()].filter((e) => e.n >= total * 0.03).map((e) => {
      const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const s = max === 0 ? 0 : (max - min) / max;
      return { r, g, b, score: e.n * (0.2 + s) };
    }).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c2 of list) {
      if (picked.every((p) => Math.abs(p.r - c2.r) + Math.abs(p.g - c2.g) + Math.abs(p.b - c2.b) > 70)) picked.push(c2);
      if (picked.length === 5) break;
    }
    const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
    $('swatches').innerHTML = '';
    for (const p of picked) {
      const h = ('#' + hex(p.r) + hex(p.g) + hex(p.b)).toUpperCase();
      const b = document.createElement('button');
      b.className = 'sw'; b.style.background = h; b.title = h; b.type = 'button';
      b.onclick = () => pickColour(h, true);
      $('swatches').appendChild(b);
    }
    $('swatch-hint').classList.toggle('hidden', picked.length === 0);
    if (!S.brand.colour && picked[0]) {
      const first = ('#' + hex(picked[0].r) + hex(picked[0].g) + hex(picked[0].b)).toUpperCase();
      pickColour(first, false);
      say('c-msg', 'Suggested from your logo. Tap Save colour to use it.', true);
    }
  } catch (e) { /* A picture we cannot read is not worth an error. */ }
}

/* Brand: the colour */
let colour = '';
function pickColour(h, touched) {
  colour = h;
  $('c-hex').value = h; $('c-input').value = h || '#F5B82E';
  document.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s.title === h));
  if (touched) say('c-msg', '');
  refreshPreview();
  dirty();
}
$('c-input').oninput = () => pickColour($('c-input').value.toUpperCase(), true);
$('c-hex').onchange = () => { const v = $('c-hex').value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) pickColour(('#' + v.replace('#', '')).toUpperCase(), true); };
$('c-save').onclick = async (e) => {
  busy(e.target, true, 'Saving\\u2026');
  try { const r = await api('/brand', { colour: colour || null }); S.brand.colour = r.colour; say('c-msg', 'Saved. Your next invoices use it.', true); }
  catch (err) { say('c-msg', err.message); }
  busy(e.target, false, 'Save colour'); dirty();
};
$('c-reset').onclick = async () => {
  try { await api('/brand', { colour: null }); S.brand.colour = null; pickColour('', true); say('c-msg', 'Back to the standard colour.', true); }
  catch (err) { say('c-msg', err.message); }
};

let t = null;
function refreshPreview() {
  if (!S || S.plan !== 'pro') return;
  clearTimeout(t);
  t = setTimeout(() => {
    const q = new URLSearchParams({ colour: colour || '', name: $('b-name').value || '' });
    $('preview').src = '/settings/' + T + '/preview?' + q.toString();
  }, 350);
}
function fit() { const f = $('frame'); f.style.setProperty('--sc', (f.clientWidth / 793.7).toFixed(4)); }
window.addEventListener('resize', fit);

/* Payout account */
let banks = null, checked = null;
$('bank-change').onclick = async () => {
  $('bank-form').classList.remove('hidden'); $('bank-change').classList.add('hidden');
  if (!banks) {
    try { banks = (await api('/banks')).banks; } catch (err) { return say('k-msg', err.message); }
    const sel = $('k-bank');
    sel.innerHTML = '<option value="">Choose your bank</option>' +
      banks.map((b) => '<option value="' + b.code + '"></option>').join('');
    [...sel.options].slice(1).forEach((o, i) => { o.textContent = banks[i].name; });
  }
};
$('k-check').onclick = async (e) => {
  checked = null; $('k-found').classList.add('hidden'); $('k-verify').classList.add('hidden');
  busy(e.target, true, 'Checking\\u2026');
  try {
    const r = await api('/bank/check', { bankCode: $('k-bank').value, accountNumber: $('k-number').value });
    checked = { bankCode: $('k-bank').value, accountNumber: $('k-number').value.replace(/\\D/g, '') };
    $('k-found').textContent = r.accountName + ' \\u00b7 ' + r.bankName;
    $('k-found').classList.remove('hidden'); $('k-verify').classList.remove('hidden'); say('k-msg', '');
  } catch (err) { say('k-msg', err.message); }
  busy(e.target, false, 'Check account'); dirty();
};
$('k-send').onclick = async (e) => {
  busy(e.target, true, 'Sending\\u2026');
  try { const r = await api('/bank/code', {}); say('k-msg', 'We emailed a 6-digit code to ' + r.to + '.', true); $('k-code-row').classList.remove('hidden'); }
  catch (err) { say('k-msg', err.message); }
  busy(e.target, false, 'Email me a code');
};
$('k-confirm').onclick = async (e) => {
  if (!checked) return;
  busy(e.target, true, 'Changing\\u2026');
  try {
    await api('/bank/confirm', { ...checked, code: $('k-code').value });
    say('k-msg', 'Done. Your invoices, including unpaid ones, now show this account.', true);
    S = await api('/state'); fill();
    $('bank-form').classList.add('hidden'); $('bank-change').classList.remove('hidden');
  } catch (err) { say('k-msg', err.message); }
  busy(e.target, false, 'Confirm change'); dirty();
};

(async () => {
  try {
    S = await api('/state'); fill(); fit();
    const back = new URLSearchParams(location.search).get('saved');
    if (back === 'design' || back === 'signature') {
      const el = $('saved');
      el.textContent = back === 'design' ? 'Design saved: ' + S.invoices.design + '.' : 'Signature saved.';
      el.classList.remove('hidden');
      history.replaceState(null, '', location.pathname);
      $(back === 'design' ? 'l-design' : 'l-sign').closest('.card').scrollIntoView({ block: 'center' });
    }
  }
  catch (err) { document.body.innerHTML = '<div class="wrap"><h1>Nothing here</h1><p class="sub">' + err.message + '</p></div>'; }
})();
`;

export function settingsPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="format-detection" content="telephone=no">
<title>Settings</title>
<link rel="stylesheet" href="/designs/fonts.css"><style>${CSS}</style></head>
<body data-t="${esc(token)}"><div class="wrap">
  <div class="top"><h1 id="title">Settings</h1><span id="plan" class="pill">&nbsp;</span></div>
  <p class="sub">Changes save section by section. Close this page when you are done.</p>
  <p class="saved hidden" id="saved" role="status"></p>

  <section class="card">
    <h2>Business</h2>
    <p class="hint">What your clients see on every invoice.</p>
    <label for="b-name">Business name</label><input id="b-name" maxlength="80" autocomplete="organization">
    <label for="b-address">Address <span style="font-weight:400">(optional)</span></label><input id="b-address" maxlength="200">
    <label for="b-tin">TIN <span style="font-weight:400">(optional)</span></label><input id="b-tin" maxlength="30">
    <label for="b-email">Email</label><input id="b-email" readonly>
    <button class="btn" id="b-save" type="button" disabled>Save details</button>
    <p class="msg" id="b-msg" role="status"></p>
  </section>

  <section class="card">
    <h2>Brand</h2>
    <p class="hint">Your logo and colour on your invoices, pay page and emails, with nothing of Balans on them.</p>
    <div id="brand-free" class="hidden">
      <p class="locked">Part of Pro: your logo and your colours on everything your clients see, and no Balans branding anywhere.</p>
      <a class="btn gold" id="brand-up" style="display:grid;place-items:center;text-decoration:none">Upgrade to Pro</a>
    </div>
    <div id="brand-pro" class="hidden">
      <label>Logo</label>
      <div class="logo">
        <div class="box" id="logo-box"><span>No logo yet</span></div>
        <div class="acts">
          <label class="btn ghost" style="display:grid;place-items:center;margin:0;color:var(--ink);font-size:15px">
            Upload logo<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
          <button class="btn ghost hidden" id="logo-remove" type="button">Remove</button>
        </div>
      </div>
      <p class="msg" id="logo-msg" role="status"></p>
      <label>Brand colour</label>
      <p class="hint hidden" id="swatch-hint">From your logo:</p>
      <div class="swatches" id="swatches"></div>
      <div class="pick"><input type="color" id="c-input" aria-label="Pick a colour"><input id="c-hex" placeholder="#1A73E8" maxlength="7" aria-label="Colour code"></div>
      <div class="row"><button class="btn" id="c-save" type="button" disabled>Save colour</button><button class="btn ghost" id="c-reset" type="button">Use standard</button></div>
      <p class="msg" id="c-msg" role="status"></p>
      <label>How your invoice looks</label>
      <div class="frame" id="frame"><iframe id="preview" title="Invoice preview" sandbox="allow-same-origin"></iframe></div>
    </div>
  </section>

  <section class="card">
    <h2>Invoices</h2>
    <div class="row">
      <div><label for="i-days">Days to pay</label><input id="i-days" type="number" min="0" max="180" inputmode="numeric"></div>
      <div><label for="i-next">Next invoice #</label><input id="i-next" type="number" min="1" inputmode="numeric"></div>
    </div>
    <button class="btn" id="i-save" type="button" disabled>Save</button>
    <p class="msg" id="i-msg" role="status"></p>
    <div style="margin-top:10px">
      <a class="link" id="l-design" href="#">Invoice design<small></small><span class="go">&rsaquo;</span></a>
      <a class="link" id="l-sign" href="#">Signature<small></small><span class="go">&rsaquo;</span></a>
    </div>
  </section>

  <section class="card">
    <h2>Clients abroad</h2>
    <p class="hint">For invoices in dollars, pounds and other currencies. Clients can pay by card through a Balans link, or straight to you by PayPal, Wise or a bank abroad.</p>
    <label for="a-details">Your payment details</label>
    <textarea id="a-details" maxlength="600" placeholder="PayPal: you@example.com&#10;or Wise: IBAN GB00 0000 0000 0000 00"></textarea>
    <label for="a-payby">Invoices abroad go out with</label>
    <select id="a-payby"><option value="link">A Balans payment link</option><option value="own">My payment details</option></select>
    <p class="hint" style="margin-top:8px">You can choose per invoice too: say <b>pay by my paypal</b> or <b>use payment link</b>. Payments to your own details are not seen by Balans, so mark them paid when they arrive.</p>
    <button class="btn" id="a-save" type="button" disabled>Save</button>
    <p class="msg" id="a-msg" role="status"></p>
  </section>

  <section class="card">
    <h2>Payout account</h2>
    <p class="hint">Where your clients pay. It is printed on your invoices.</p>
    <div class="bank" id="bank-now"></div>
    <button class="btn ghost" id="bank-change" type="button">Change account</button>
    <div id="bank-form" class="hidden">
      <label for="k-bank">Bank</label><select id="k-bank"><option>Loading banks…</option></select>
      <label for="k-number">Account number</label><input id="k-number" inputmode="numeric" maxlength="10" autocomplete="off">
      <button class="btn" id="k-check" type="button" disabled>Check account</button>
      <div class="found hidden" id="k-found"></div>
      <div id="k-verify" class="hidden">
        <p class="hint" style="margin-top:12px">To keep your money safe, we email you a code before changing where you are paid.</p>
        <button class="btn gold" id="k-send" type="button">Email me a code</button>
        <div id="k-code-row" class="hidden">
          <label for="k-code">Code from the email</label><input id="k-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
          <button class="btn" id="k-confirm" type="button" disabled>Confirm change</button>
        </div>
      </div>
      <p class="msg" id="k-msg" role="status"></p>
    </div>
  </section>

  <section class="card">
    <h2>Plan</h2>
    <p class="hint" id="plan-text"></p>
    <a class="btn gold hidden" id="plan-btn" style="display:grid;place-items:center;text-decoration:none"></a>
  </section>

  <p class="foot">To close your account, reply <b>close my account</b> on WhatsApp.</p>
</div><script>${JS}</script></body></html>`;
}

function gonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Link expired</title>
<link rel="stylesheet" href="/designs/fonts.css"><style>${CSS}</style></head>
<body><div class="wrap"><h1>This link has expired</h1>
<p class="sub" style="margin-top:8px">Reply <b>settings</b> on WhatsApp for a new one.</p></div></body></html>`;
}
