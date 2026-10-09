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
import { logoSvg } from "../../brand/logo.ts";
import { renderTemplate, TEMPLATES } from "../../pdf/templates.ts";
import { pickerUrlFor } from "./templates.ts";
import { issueSignatureToken } from "../../brand/signature.ts";
import { proStartUrl } from "../../billing/pro-link.ts";
import { renewalOpen, stateOf } from "../../billing/subscription.ts";
import { cachedBanks } from "../../payments/paystack.ts";
import { checkAccount } from "../../payments/bank-directory.ts";
import { finishChange, sendChangeCode } from "../../whatsapp/flows/actions.ts";
import { PAY_METHODS } from "../../whatsapp/flows/pay-methods.ts";
import { abroadCurrencyFor } from "../../../core/home-currency.ts";

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
  payment_method: string | null;
  wa_phone: string;
};

async function load(userId: string): Promise<Row> {
  const { rows } = await db().query<Row>(
    `SELECT u.business_name, u.email, u.email_verified_at IS NOT NULL AS email_verified, u.address, u.tin,
            u.plan, u.logo_url, u.brand_color, u.signature_url, u.default_due_days,
            u.invoice_number_start, u.template_id, u.payment_details, u.abroad_pay_by, u.payment_method, u.wa_phone,
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
    abroad: { details: u.payment_details ?? "", payBy: u.abroad_pay_by, method: u.payment_method ?? "" },
    // Outside Nigeria (Phase 3): no Nigerian bank, paid to their own details.
    livesAbroad: abroadCurrencyFor(u.wa_phone) !== null,
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
  const [u, account] = await Promise.all([load(userId), accountInForce(userId)]);
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
    // Their own account, as a naira invoice carries it; the number masked,
    // since a preview is not the place to print it whole.
    bankDetails: account
      ? { bankName: account.bankName, accountName: account.accountName, accountNumber: `••••••${account.last4}` }
      : null,
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
  app.post<{ Params: { token: string }; Body: { details?: string; payBy?: string; method?: string } }>(
    "/settings/:token/abroad",
    async (req, reply) => {
      const owner = await who(req.params.token);
      if (!owner) return nope(reply, "This link has expired.", 404);
      const details = String(req.body?.details ?? "").replace(/\r\n?/g, "\n").trim();
      const abroad = abroadCurrencyFor((await load(owner.id)).wa_phone) !== null;
      // Outside Nigeria there is no link to fall back on: always their details.
      const payBy = abroad || req.body?.payBy === "own" ? "own" : "link";
      const method = String(req.body?.method ?? "").trim();
      if (method && !PAY_METHODS.some((m) => m.id === method)) return nope(reply, "Choose how your clients pay you.");
      if (details.length > 600) return nope(reply, "Keep your payment details under 600 characters.");
      if (payBy === "own" && !details) return nope(reply, "Add your payment details first, or keep the payment link.");
      await db().query(
        `UPDATE users SET payment_details = NULLIF($2, ''), abroad_pay_by = $3,
                payment_method = COALESCE(NULLIF($4, ''), payment_method) WHERE id = $1`,
        [owner.id, details, payBy, method],
      );
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
:root{--marigold:#f5b82e;--ink:#10231c;--ink2:#173128;--cream:#f6f1e7;--sand:#e9e1d0;--paper:#ffffff;
--line:rgba(16,35,28,.09);--muted:#5f6f67;--faint:#8a978f;--moss:#2f7a4b;--clay:#b8452d;
--lift:0 0 0 1px rgba(16,35,28,.06),0 1px 2px rgba(16,35,28,.05),0 12px 32px -18px rgba(16,35,28,.2)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:${FONT.sans};-webkit-font-smoothing:antialiased;
line-height:1.5;padding:0 0 64px}
button{cursor:pointer;font:inherit}
.hidden{display:none!important}
/* The head: who these settings belong to, on the same ink band as the pay
   page, the designs and the summary. */
.band{background:var(--ink);color:var(--cream);padding:24px 16px 26px}
.band .in{max-width:1040px;margin:0 auto;display:flex;align-items:center;gap:14px}
.av{width:48px;height:48px;border-radius:14px;flex:none;display:grid;place-items:center;background:var(--marigold);
color:var(--ink);font-family:${FONT.display};font-weight:800;font-size:18px;letter-spacing:-.03em}
.who{min-width:0;flex:1}
.who .k{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(246,241,231,.5)}
h1{font-family:${FONT.display};font-size:24px;font-weight:800;letter-spacing:-.035em;line-height:1.15;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{flex:none;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:5px 10px;border-radius:99px;
background:rgba(246,241,231,.12);color:rgba(246,241,231,.85);white-space:nowrap}
.pill.pro{background:var(--marigold);color:var(--ink)}
.shell{max-width:1040px;margin:0 auto;padding:0 16px}
/* The sections: a row of tabs on a phone, kept in reach as the page
   scrolls; a column down the side from 860px. */
.tabs{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;margin:0 -16px;padding:12px 16px;
background:rgba(246,241,231,.92);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
scrollbar-width:none;-webkit-overflow-scrolling:touch}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;display:inline-flex;align-items:center;gap:8px;border:0;background:var(--paper);color:var(--muted);
font-size:14px;font-weight:600;height:38px;padding:0 15px 0 12px;border-radius:99px;white-space:nowrap;
box-shadow:inset 0 0 0 1px var(--line);transition:background-color .2s,color .2s}
.tab svg{width:16px;height:16px;flex:none;opacity:.75}
.tab[aria-selected="true"]{background:var(--ink);color:var(--cream);box-shadow:none}
.tab[aria-selected="true"] svg{opacity:1}
.panes{min-width:0}
@media(min-width:860px){
  .band{padding:34px 24px 34px}
  .av{width:56px;height:56px;font-size:21px;border-radius:16px}
  h1{font-size:28px}
  .shell{display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px;padding:28px 24px 0;align-items:start}
  .tabs{flex-direction:column;gap:2px;margin:0;padding:0;background:none;backdrop-filter:none;-webkit-backdrop-filter:none;
    top:24px;overflow:visible}
  .tab{height:42px;width:100%;background:none;box-shadow:none;border-radius:12px;padding:0 12px}
  .tab:hover{background:rgba(16,35,28,.05)}
  .tab[aria-selected="true"]{background:var(--paper);color:var(--ink);box-shadow:var(--lift)}
}
.saved{margin:4px 0 12px;display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:14px;background:#eef7f1;
color:var(--moss);font-weight:600;font-size:14.5px;box-shadow:0 0 0 1px rgba(47,122,75,.18)}
/* A section: a heading, its fields, and a bar along the foot holding the
   one thing to press and what happened when it was pressed. */
.card{background:var(--paper);border-radius:20px;box-shadow:var(--lift);overflow:hidden;animation:in .25s ease-out}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
@media(prefers-reduced-motion:reduce){.card{animation:none}}
.card.off{display:none}
.ch{padding:22px 22px 4px}
.card h2{font-family:${FONT.display};font-size:19px;font-weight:700;letter-spacing:-.025em}
.hint{color:var(--muted);font-size:14px;margin-top:4px;max-width:60ch}
.hint b{color:var(--ink)}
.cb{padding:6px 22px 22px}
.cf{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;padding:14px 22px;
border-top:1px solid var(--line);background:#fcfaf6}
.cf .msg{margin:0 auto 0 0;flex:1;min-width:10em}
.field{padding:14px 0;border-top:1px solid var(--line)}
.field:first-child{border-top:0}
.field>label,.field>.lb{display:block;font-size:13.5px;font-weight:600;color:var(--ink)}
.field .opt{font-weight:400;color:var(--faint)}
.field .help{display:block;font-size:12.5px;font-weight:400;color:var(--muted);margin-top:2px}
@media(min-width:860px){
  .ch{padding:26px 28px 6px}
  .cb{padding:6px 28px 26px}
  .cf{padding:14px 28px}
  .field{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;align-items:start}
  .field>label,.field>.lb{padding-top:12px}
  .field>input,.field>select,.field>textarea,.field>div{margin-top:0!important}
}
input,select{width:100%;margin-top:7px;height:46px;border:1px solid rgba(16,35,28,.14);border-radius:12px;background:#fff;
padding:0 13px;font:inherit;font-size:16px;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s;
box-shadow:0 1px 2px rgba(16,35,28,.04)}
select{appearance:none;-webkit-appearance:none;padding-right:38px;
background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4 6l4 4 4-4' stroke='%235f6f67' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") right 13px center/14px no-repeat}
input:focus,select:focus,textarea:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(16,35,28,.08)}
input[readonly]{background:var(--cream);color:var(--muted);box-shadow:none;border-color:transparent}
textarea{width:100%;margin-top:7px;min-height:112px;border:1px solid rgba(16,35,28,.14);border-radius:12px;background:#fff;
padding:11px 13px;font:inherit;font-size:16px;line-height:1.45;color:var(--ink);outline:none;resize:vertical}
.row{display:flex;gap:10px}.row>*{flex:1;min-width:0}
/* Pills, as every button on balans.ng is. */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px;border:0;border-radius:999px;
background:var(--ink);color:var(--cream);font-weight:600;font-size:14.5px;text-decoration:none;white-space:nowrap;
transition:opacity .2s,transform .15s}
.btn:active{transform:scale(.98)}
.btn.gold{background:var(--marigold);color:var(--ink);box-shadow:inset 0 -2px 0 rgba(16,35,28,.12)}
.btn.ghost{background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1px rgba(16,35,28,.16)}
.btn.wide{width:100%}
.btn:disabled{opacity:.35;cursor:not-allowed;transform:none}
@media(max-width:520px){.cf .btn{flex:1}}
.msg{font-size:13.5px;min-height:1px}
.msg.ok{color:var(--moss)}.msg.err{color:var(--clay)}
/* Invoices: the two pages it opens, as rows. */
.links{margin-top:6px;border-radius:16px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.link{display:flex;align-items:center;gap:14px;padding:14px 16px;border-top:1px solid var(--line);color:var(--ink);
text-decoration:none;font-weight:600;font-size:15px;transition:background-color .15s}
.link:first-child{border-top:0}
.link:hover{background:#fcfaf6}
.link .ic{width:38px;height:38px;border-radius:12px;background:var(--cream);display:grid;place-items:center;flex:none}
.link .ic svg{width:18px;height:18px}
.link .tx{flex:1;min-width:0}
.link small{display:block;font-weight:400;color:var(--muted);font-size:13px}
.link .go{color:var(--faint);font-size:22px;line-height:1}
/* Brand. */
.brandgrid{display:grid;gap:22px}
@media(min-width:1000px){.brandgrid{grid-template-columns:minmax(0,1fr) 260px}}
/* Beside the preview there is no room for a label column: the label sits
   over its control instead. */
@media(min-width:860px){.brandgrid .field{display:block}.brandgrid .field>.lb{padding-top:0;margin-bottom:6px}}
.logo{display:flex;align-items:center;gap:14px;margin-top:8px}
.logo .box{width:92px;height:92px;border-radius:18px;border:1.5px dashed rgba(16,35,28,.2);background:var(--cream);display:grid;
place-items:center;overflow:hidden;flex:none;padding:8px}
.logo .box img{max-width:100%;max-height:100%;object-fit:contain}
.logo .box span{font-size:11.5px;color:var(--faint);text-align:center;padding:6px}
.logo .acts{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}
.logo .acts .btn{width:100%}
.swatches{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.sw{width:40px;height:40px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px var(--line);transition:transform .15s}
.sw:active{transform:scale(.94)}
.sw.on{box-shadow:0 0 0 2px var(--ink)}
.pick{display:flex;gap:10px;align-items:center;margin-top:10px}
.pick input[type=color]{width:52px;height:46px;padding:4px;flex:none;margin-top:0}
.pick input{margin-top:0}
.brow{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.brow .btn{flex:1}
.pv .lb{display:block;font-size:13.5px;font-weight:600;margin-bottom:8px}
.frame{border-radius:12px;overflow:hidden;background:#fff;position:relative;
box-shadow:0 0 0 1px var(--line),0 16px 36px -20px rgba(16,35,28,.35);height:calc(1122.5px * var(--sc));--sc:.42}
.frame::before{content:"Loading preview…";position:absolute;top:45%;left:0;right:0;text-align:center;color:var(--faint);font-size:14px}
.frame iframe{position:absolute;top:0;left:0;width:793.7px;height:1122.5px;border:0;transform:scale(var(--sc));transform-origin:top left}
.locked{margin-top:6px;padding:18px;border-radius:16px;background:var(--ink);color:var(--cream)}
.locked p{font-size:14.5px;color:rgba(246,241,231,.8)}
.locked .btn{margin-top:14px}
/* Payout: the account as a card, because it is one. */
.bank{position:relative;margin-top:6px;padding:20px 20px 18px;border-radius:18px;color:var(--cream);overflow:hidden;
background:radial-gradient(120% 140% at 100% 0%,#24463a 0%,var(--ink) 55%);min-height:118px;display:flex;flex-direction:column;justify-content:flex-end;gap:2px}
.bank::before{content:"";position:absolute;top:18px;left:20px;width:34px;height:24px;border-radius:6px;
background:linear-gradient(135deg,#f7cf6a,#d99a12)}
.bank::after{content:"";position:absolute;top:16px;right:18px;width:28px;height:28px;border-radius:50%;background:rgba(246,241,231,.08)}
.bank b{display:block;font-family:${FONT.display};font-size:17px;letter-spacing:-.01em}
.bank span{color:rgba(246,241,231,.62);font-size:13.5px;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.found{margin-top:12px;padding:12px 14px;border-radius:12px;background:#eef7f1;color:var(--moss);font-weight:600}
.step{margin-top:14px;padding:16px;border-radius:16px;background:#fcfaf6;box-shadow:inset 0 0 0 1px var(--line)}
.step .hint{margin-top:0}
.step .btn{margin-top:12px}
/* Plan. */
.plan{display:grid;gap:16px}
.plancard{padding:20px;border-radius:18px;background:var(--ink);color:var(--cream)}
.plancard .pt{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(246,241,231,.5)}
.plancard .pn{margin-top:4px;font-family:${FONT.display};font-size:24px;font-weight:800;letter-spacing:-.03em}
.plancard .hint{color:rgba(246,241,231,.7)}
.plancard ul{list-style:none;margin-top:14px;display:grid;gap:8px}
.plancard li{display:flex;align-items:center;gap:10px;font-size:14px;color:rgba(246,241,231,.85)}
.plancard li::before{content:"";width:18px;height:18px;flex:none;border-radius:50%;
background:var(--marigold) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2310231c' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5 10 17.5 19 7.5'/%3E%3C/svg%3E") center/11px no-repeat}
.foot{margin:28px auto 0;max-width:1040px;padding:0 16px;display:flex;flex-direction:column;align-items:center;gap:12px;
text-align:center;color:var(--faint);font-size:12.5px}
.foot b{color:var(--muted)}
.foot svg{display:block;opacity:.85}
/* The page for an expired link, and for one that would not load. */
.wrap{max-width:560px;margin:0 auto;padding:40px 16px}
.wrap h1{white-space:normal;color:var(--ink)}
.wrap .sub{color:var(--muted);font-size:15px;margin-top:8px}
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
const initials = (n) => (n || '').split(/\\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'B';

function fill() {
  $('title').textContent = S.business.name || 'Your settings';
  $('av').textContent = initials(S.business.name);
  $('plan-name').textContent = S.plan === 'pro' ? 'Balans Pro' : 'Balans Free';
  $('plan-incl').textContent = S.plan === 'pro' ? 'Included' : 'Pro adds';
  $('plan').textContent = S.plan === 'pro' ? 'Pro' : 'Free';
  $('plan').className = 'pill' + (S.plan === 'pro' ? ' pro' : '');
  $('b-name').value = S.business.name; $('b-address').value = S.business.address; $('b-tin').value = S.business.tin;
  $('b-email').value = S.business.email ? S.business.email + (S.business.emailVerified ? '' : ' (not verified)') : 'None';
  $('i-days').value = S.invoices.dueDays; $('i-next').value = S.invoices.nextNumber;
  $('a-details').value = S.abroad.details; $('a-payby').value = S.abroad.payBy; $('a-method').value = S.abroad.method;
  // Outside Nigeria: how they get paid is this tab, and there is no Nigerian bank.
  if (S.livesAbroad) {
    document.querySelector('.tab[data-tab="payout"]').remove();
    // Hidden, not removed: the script below still reads its fields.
    document.querySelector('section[data-tab="payout"]').dataset.tab = 'none';
    document.querySelector('.tab[data-tab="abroad"] .tl').textContent = 'How you get paid';
    $('a-title').textContent = 'How you get paid';
    $('a-hint').textContent = 'Your clients pay you directly. These go on every invoice, as you write them.';
    $('a-payby-row').classList.add('hidden');
  }
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
    a: [val('a-details'), $('a-payby').value, $('a-method').value].join('\u0000'),
  };
  dirty();
}
function dirty() {
  $('b-save').disabled = !val('b-name') || [val('b-name'), val('b-address'), val('b-tin')].join('\u0000') === saved.b;
  $('a-save').disabled = [val('a-details'), $('a-payby').value, $('a-method').value].join('\u0000') === saved.a
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
$('a-method').addEventListener('change', dirty);
$('k-bank').addEventListener('change', () => { checked = null; $('k-found').classList.add('hidden'); $('k-verify').classList.add('hidden'); dirty(); });
$('k-number').addEventListener('input', () => { if (checked) { checked = null; $('k-found').classList.add('hidden'); $('k-verify').classList.add('hidden'); } });

/* Business */
$('b-save').onclick = async (e) => {
  busy(e.target, true, 'Saving\\u2026');
  try {
    await api('/business', { name: $('b-name').value, address: $('b-address').value, tin: $('b-tin').value });
    S.business.name = $('b-name').value.trim(); $('title').textContent = S.business.name; $('av').textContent = initials(S.business.name);
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
    await api('/abroad', { details: $('a-details').value, payBy: $('a-payby').value, method: $('a-method').value });
    S.abroad = { details: val('a-details'), payBy: $('a-payby').value, method: $('a-method').value };
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

/* Tabs: one section at a time. The open one is kept in the address, so a
   reload, or coming back from the design or signature page, lands on it. */
function showTab(name) {
  // Read each time: a tab can be taken away once the state is known.
  const TABS = [...document.querySelectorAll('.tab')].map((b) => b.dataset.tab);
  if (!TABS.includes(name)) name = TABS[0];
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('section.card[data-tab]').forEach((s) => s.classList.toggle('off', s.dataset.tab !== name));
  const btn = document.querySelector('.tab[data-tab="' + name + '"]');
  if (btn) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
  history.replaceState(null, '', location.pathname + location.search + '#' + name);
  $('saved').classList.add('hidden');
  if (name === 'brand') fit();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

(async () => {
  try {
    S = await api('/state'); fill();
    const back = new URLSearchParams(location.search).get('saved');
    showTab(back === 'design' || back === 'signature' ? 'invoices' : location.hash.slice(1));
    if (back === 'design' || back === 'signature') {
      const el = $('saved');
      el.textContent = back === 'design' ? 'Design saved: ' + S.invoices.design + '.' : 'Signature saved.';
      el.classList.remove('hidden');
      history.replaceState(null, '', location.pathname + '#invoices');
    }
  }
  catch (err) { document.body.innerHTML = '<div class="wrap"><h1>Nothing here</h1><p class="sub"></p></div>'; document.querySelector('.sub').textContent = err.message; }
})();
`;

const ICON = {
  business: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 17V6.5L10 3l7 3.5V17M3 17h14M7.5 17v-4h5v4M7 8.5h.01M10 8.5h.01M13 8.5h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  brand: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17a7 7 0 1 1 7-7c0 1.7-1.3 2.5-2.6 2.5H12.8a1.6 1.6 0 0 0-1.2 2.7c.4.4.1 1.8-1.6 1.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.6" cy="9.4" r="1" fill="currentColor"/><circle cx="9" cy="6.3" r="1" fill="currentColor"/><circle cx="12.6" cy="6.8" r="1" fill="currentColor"/></svg>`,
  invoices: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 2.8h7l3 3V17.2H5V2.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 2.8V6h3M7.5 10h5M7.5 13h3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  abroad: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.6"/><path d="M2.8 10h14.4M10 2.8c2 2 2.9 4.4 2.9 7.2S12 15.2 10 17.2C8 15.2 7.1 12.8 7.1 10S8 4.8 10 2.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  payout: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.8 7.5 10 3.3l7.2 4.2H2.8ZM4.5 8v6.3M8.2 8v6.3M11.8 8v6.3M15.5 8v6.3M2.8 16.7h14.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plan: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2.8 2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.6l-4.3 2.3.9-4.8-3.5-3.3 4.8-.6L10 2.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  design: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3.5" y="2.8" width="13" height="14.4" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 6.5h7M6.5 9.5h4M6.5 13.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  sign: `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 15.5c2.5-1 3.6-8.5 6-8.5 1.7 0-.3 6.3 1.2 6.3 1.1 0 1.6-2.2 2.6-2.2.8 0 .9 1.6 1.7 1.6.6 0 1.1-.6 1.5-1.1M3 17.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const tab = (id: keyof typeof ICON, label: string) =>
  `<button class="tab" type="button" role="tab" data-tab="${id}" aria-selected="false">${ICON[id]}<span class="tl">${label}</span></button>`;

export function settingsPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="format-detection" content="telephone=no">
<title>Settings</title>
<link rel="stylesheet" href="/designs/fonts.css"><style>${CSS}</style></head>
<body data-t="${esc(token)}">
<header class="band"><div class="in">
  <span class="av" id="av" aria-hidden="true"></span>
  <div class="who"><p class="k">Settings</p><h1 id="title">Settings</h1></div>
  <span id="plan" class="pill">&nbsp;</span>
</div></header>

<div class="shell">
  <nav class="tabs" role="tablist" aria-label="Settings sections">
    ${tab("business", "Business")}${tab("brand", "Brand")}${tab("invoices", "Invoices")}${tab("abroad", "Clients abroad")}${tab("payout", "Payout account")}${tab("plan", "Plan")}
  </nav>

  <main class="panes">
  <p class="saved hidden" id="saved" role="status"></p>

  <section class="card" data-tab="business">
    <div class="ch"><h2>Business</h2><p class="hint">What your clients see at the top of every invoice.</p></div>
    <div class="cb">
      <div class="field"><label for="b-name">Business name</label><input id="b-name" maxlength="80" autocomplete="organization"></div>
      <div class="field"><label for="b-address">Address <span class="opt">optional</span></label><input id="b-address" maxlength="200"></div>
      <div class="field"><label for="b-tin">TIN <span class="opt">optional</span><span class="help">Printed on invoices when you add it.</span></label><input id="b-tin" maxlength="30"></div>
      <div class="field"><label for="b-email">Email<span class="help">Where receipts and codes are sent.</span></label><input id="b-email" readonly></div>
    </div>
    <div class="cf"><p class="msg" id="b-msg" role="status"></p><button class="btn" id="b-save" type="button" disabled>Save details</button></div>
  </section>

  <section class="card" data-tab="brand">
    <div class="ch"><h2>Brand</h2><p class="hint">Your logo and colour on your invoices, pay page and emails, with nothing of Balans on them.</p></div>
    <div class="cb">
      <div id="brand-free" class="hidden">
        <div class="locked">
          <p>Part of Pro: your logo and your colours on everything your clients see, and no Balans branding anywhere.</p>
          <a class="btn gold" id="brand-up">Upgrade to Pro</a>
        </div>
      </div>
      <div id="brand-pro" class="hidden">
        <div class="brandgrid">
          <div>
            <div class="field"><span class="lb">Logo<span class="help">PNG, JPG or WebP, up to 2 MB.</span></span>
              <div>
                <div class="logo">
                  <div class="box" id="logo-box"><span>No logo yet</span></div>
                  <div class="acts">
                    <label class="btn ghost" style="margin:0">Upload logo<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
                    <button class="btn ghost hidden" id="logo-remove" type="button">Remove</button>
                  </div>
                </div>
                <p class="msg" id="logo-msg" role="status" style="margin-top:8px"></p>
              </div>
            </div>
            <div class="field"><span class="lb">Brand colour<span class="help hidden" id="swatch-hint">Suggested from your logo.</span></span>
              <div>
                <div class="swatches" id="swatches"></div>
                <div class="pick"><input type="color" id="c-input" aria-label="Pick a colour"><input id="c-hex" placeholder="#1A73E8" maxlength="7" aria-label="Colour code"></div>
                <div class="brow"><button class="btn" id="c-save" type="button" disabled>Save colour</button><button class="btn ghost" id="c-reset" type="button">Use standard</button></div>
                <p class="msg" id="c-msg" role="status" style="margin-top:8px"></p>
              </div>
            </div>
          </div>
          <div class="pv">
            <span class="lb">How your invoice looks</span>
            <div class="frame" id="frame"><iframe id="preview" title="Invoice preview" sandbox="allow-same-origin"></iframe></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="card" data-tab="invoices">
    <div class="ch"><h2>Invoices</h2><p class="hint">How your invoices are numbered and when they fall due.</p></div>
    <div class="cb">
      <div class="field"><label for="i-days">Days to pay<span class="help">Due this many days after you send.</span></label><input id="i-days" type="number" min="0" max="180" inputmode="numeric"></div>
      <div class="field"><label for="i-next">Next invoice number</label><input id="i-next" type="number" min="1" inputmode="numeric"></div>
      <div class="field"><span class="lb">Look</span>
        <div class="links">
          <a class="link" id="l-design" href="#"><span class="ic">${ICON.design}</span><span class="tx">Invoice design<small></small></span><span class="go">&rsaquo;</span></a>
          <a class="link" id="l-sign" href="#"><span class="ic">${ICON.sign}</span><span class="tx">Signature<small></small></span><span class="go">&rsaquo;</span></a>
        </div>
      </div>
    </div>
    <div class="cf"><p class="msg" id="i-msg" role="status"></p><button class="btn" id="i-save" type="button" disabled>Save</button></div>
  </section>

  <section class="card" data-tab="abroad">
    <div class="ch"><h2 id="a-title">Clients abroad</h2><p class="hint" id="a-hint">For invoices in dollars, pounds and other currencies. Clients can pay by card through a Balans link, or straight to you by PayPal, Wise or a bank abroad.</p></div>
    <div class="cb">
      <div class="field"><label for="a-method">Payment method</label>
        <select id="a-method"><option value="">Choose…</option>${PAY_METHODS.map((m) => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join("")}</select></div>
      <div class="field"><label for="a-details">Your payment details<span class="help">Printed on invoices that use them.</span></label>
        <textarea id="a-details" maxlength="600" placeholder="PayPal: you@example.com&#10;or Wise: IBAN GB00 0000 0000 0000 00"></textarea></div>
      <div class="field" id="a-payby-row"><label for="a-payby">Invoices abroad go out with</label>
        <select id="a-payby"><option value="link">A Balans payment link</option><option value="own">My payment details</option></select></div>
      <p class="hint" style="margin-top:6px">You can choose per invoice too: say <b>pay by my paypal</b> or <b>use payment link</b>. Payments to your own details are not seen by Balans, so mark them paid when they arrive.</p>
    </div>
    <div class="cf"><p class="msg" id="a-msg" role="status"></p><button class="btn" id="a-save" type="button" disabled>Save</button></div>
  </section>

  <section class="card" data-tab="payout">
    <div class="ch"><h2>Payout account</h2><p class="hint">Where your clients pay. It is printed on your invoices.</p></div>
    <div class="cb">
      <div class="bank" id="bank-now"></div>
      <button class="btn ghost wide" id="bank-change" type="button" style="margin-top:12px">Change account</button>
      <div id="bank-form" class="hidden">
        <div class="field"><label for="k-bank">Bank</label><select id="k-bank"><option>Loading banks…</option></select></div>
        <div class="field"><label for="k-number">Account number</label><input id="k-number" inputmode="numeric" maxlength="10" autocomplete="off"></div>
        <button class="btn wide" id="k-check" type="button" disabled>Check account</button>
        <div class="found hidden" id="k-found"></div>
        <div id="k-verify" class="hidden step">
          <p class="hint">To keep your money safe, we email you a code before changing where you are paid.</p>
          <button class="btn gold wide" id="k-send" type="button">Email me a code</button>
          <div id="k-code-row" class="hidden">
            <div class="field" style="border-top:0"><label for="k-code">Code from the email</label><input id="k-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
            <button class="btn wide" id="k-confirm" type="button" disabled>Confirm change</button>
          </div>
        </div>
        <p class="msg" id="k-msg" role="status" style="margin-top:10px"></p>
      </div>
    </div>
  </section>

  <section class="card" data-tab="plan">
    <div class="ch"><h2>Plan</h2></div>
    <div class="cb plan">
      <div class="plancard">
        <p class="pt">Your plan</p>
        <p class="pn" id="plan-name"></p>
        <p class="hint" id="plan-text"></p>
        <p class="pt" id="plan-incl" style="margin-top:18px"></p>
        <ul style="margin-top:10px">
          <li>Unlimited invoices, quotes and receipts</li>
          <li>All ${TEMPLATES.filter((t) => t.ready).length} invoice designs</li>
          <li>Your logo and colour on everything</li>
          <li>No Balans branding anywhere</li>
        </ul>
      </div>
      <a class="btn gold wide hidden" id="plan-btn"></a>
    </div>
  </section>
  </main>
</div>

<footer class="foot">
  <p>To close your account, reply <b>close my account</b> on WhatsApp.</p>
  ${logoSvg("24px")}
</footer>
<script>${JS}</script></body></html>`;
}

function gonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Link expired</title>
<link rel="stylesheet" href="/designs/fonts.css"><style>${CSS}</style></head>
<body><div class="wrap"><h1>This link has expired</h1>
<p class="sub">Reply <b>settings</b> on WhatsApp for a new one.</p></div></body></html>`;
}
