/**
 * The identity page: NIN and a selfie, and an RC or BN number when the
 * payout account is a business's (identity/verify.ts).
 *
 * A page rather than a WhatsApp form because a form cannot open the camera.
 * Opened from a link in the chat that lasts a day, like the signature page,
 * and shaped like it: the head on ink, one card.
 *
 * The selfie is taken with the phone's own camera (`capture="user"`), shrunk
 * in the page to a 720px JPEG, sent once and never stored. The NIN is sent
 * over the same request and kept encrypted.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { env } from "../../config.ts";
import { BAND, GOLD, darkLogo } from "../../brand/web.ts";
import { FONT } from "../../pdf/fonts.ts";
import {
  issueIdentityToken,
  ownerOfIdentityToken,
  requestReview,
  verifyBusiness,
  verifyPerson,
  type BusinessOutcome,
  type IdentityStatus,
  type PersonOutcome,
} from "../../identity/verify.ts";
import { sendText } from "../../whatsapp/client.ts";
import { b, lines } from "../../whatsapp/format.ts";

const HTML = "text/html; charset=utf-8";

/** A 720px JPEG is well under a megabyte; base64 and JSON around it. */
const MAX_BODY = 3 * 1024 * 1024;

export const identityUrl = async (userId: string): Promise<string> =>
  `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/verify/${await issueIdentityToken(userId)}`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What each outcome says on the page. */
export const PERSON_WORDS: Record<PersonOutcome["kind"], string> = {
  verified: "You're verified.",
  business_needed: "",
  no_account: "Add your payout account first, then come back to this link.",
  bad_nin: "A NIN is 11 digits. Check it and try again.",
  not_live: "We couldn't see a live face. Take the selfie again in good light, face the camera, alone in the picture.",
  no_match: "Your selfie didn't match the photo on that NIN. Make sure it's your own NIN, then try again in good light.",
  nin_not_found: "We couldn't find that NIN. Check the 11 digits and try again.",
  too_many: "That's three tries today. Try again tomorrow, or email hello@balans.ng.",
  unavailable: "The check isn't answering right now. Try again in a few minutes.",
};

export const BUSINESS_WORDS: Record<BusinessOutcome["kind"], string> = {
  verified: "You're verified.",
  review: "That didn't line up on the CAC register, so a person will look at it. We'll message you on WhatsApp.",
  not_found: "We couldn't find that number on the CAC register. Check it, and whether it's RC or BN.",
  bad_number: "Enter the number on your CAC certificate, like RC 1234567 or BN 1234567.",
  person_first: "Verify your NIN and selfie first.",
  too_many: "That's three tries today. Try again tomorrow, or email hello@balans.ng.",
  unavailable: "The check isn't answering right now. Try again in a few minutes.",
};

const CSS = `
:root{--ink:#10231C;--cream:#F6F1E7;--paper:#FFFFFF;--gold:#F5B82E;--line:rgba(16,35,28,.12);--faint:rgba(16,35,28,.6);--moss:#2f6b47;--clay:#c2462e}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--cream);color:var(--ink);font-family:${FONT.brand};-webkit-font-smoothing:antialiased;min-height:100dvh;padding-bottom:48px}
.top{background:${BAND};color:var(--cream);padding:22px 18px 92px}
.in,.wrap{max-width:520px;margin:0 auto}
.brand{display:flex}
h1{margin-top:24px;font-weight:400;font-size:32px;line-height:1.08;letter-spacing:-.045em}
.top p{margin-top:10px;color:rgba(246,241,231,.72);font-size:15px;line-height:1.5}
.wrap{padding:0 16px;margin-top:-64px}
.card{background:var(--paper);border-radius:28px;padding:22px 18px;box-shadow:0 0 0 1px rgba(16,35,28,.06),0 14px 34px -18px rgba(16,35,28,.25)}
.step+.step{margin-top:22px;padding-top:22px;border-top:1px solid var(--line)}
label{display:block;font-weight:500;font-size:14px;margin-bottom:8px}
.hint{color:var(--faint);font-size:13.5px;line-height:1.5;margin-top:6px}
input[type=text]{width:100%;height:50px;border-radius:14px;border:1.5px solid var(--line);padding:0 14px;font-family:inherit;font-weight:500;font-size:18px;letter-spacing:.06em;color:var(--ink);background:#fff}
input[type=text]:focus{outline:none;border-color:var(--ink)}
.shot{display:flex;align-items:center;gap:14px}
.face{width:72px;height:72px;border-radius:50%;background:var(--cream);flex:none;overflow:hidden;display:grid;place-items:center;color:var(--faint);font-size:26px}
.face img{width:100%;height:100%;object-fit:cover}
.pill{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 20px;border-radius:999px;border:0;font-family:inherit;font-weight:500;font-size:15px;cursor:pointer;text-decoration:none}
.pill.ghost{background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1px rgba(16,35,28,.16)}
.pill.gold{${GOLD};width:100%;height:52px;margin-top:22px}
.pill:disabled{opacity:.5}
.seg{display:flex;gap:8px;margin-bottom:12px}
.seg label{flex:1;margin:0}
.seg input{position:absolute;opacity:0}
.seg span{display:flex;align-items:center;justify-content:center;height:44px;border-radius:999px;background:rgba(16,35,28,.06);font-weight:500;font-size:14px;cursor:pointer}
.seg input:checked+span{background:var(--ink);color:var(--cream)}
.say{margin-top:14px;font-size:14px;line-height:1.5;min-height:1em}
.say.err{color:var(--clay)}.say.ok{color:var(--moss)}
.done{text-align:center;padding:18px 4px}
.done .tick{width:56px;height:56px;border-radius:50%;background:var(--moss);color:#fff;display:grid;place-items:center;margin:0 auto 14px;font-size:28px}
.done h2{font-size:26px;font-weight:400;letter-spacing:-.04em}
.done p{margin-top:8px;color:var(--faint);line-height:1.5}
.fine{margin-top:16px;color:var(--faint);font-size:12.5px;line-height:1.55}
.link{background:none;border:0;color:var(--ink);font-family:inherit;font-weight:500;font-size:14px;line-height:1.4;text-decoration:underline;cursor:pointer;margin-top:14px}
[hidden]{display:none!important}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const say = (id, t, cls) => { const e = $(id); e.textContent = t || ""; e.className = "say" + (cls ? " " + cls : ""); };
let selfie = null;

$("pick").addEventListener("click", () => $("cam").click());
$("cam").addEventListener("change", async () => {
  const f = $("cam").files[0]; if (!f) return;
  const img = new Image(); img.src = URL.createObjectURL(f);
  await img.decode();
  const k = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  selfie = c.toDataURL("image/jpeg", 0.85);
  $("face").innerHTML = '<img alt="" src="' + selfie + '">';
  $("pick").textContent = "Retake";
});

async function post(path, body) {
  const r = await fetch(location.pathname + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false, words: "Something went wrong. Try again." }));
}

function show(state, account) {
  $("person").hidden = state !== "none";
  $("business").hidden = state !== "person";
  $("verified").hidden = state !== "verified";
  $("review").hidden = state !== "review";
  if (account) $("acct").textContent = account;
}

$("go").addEventListener("click", async () => {
  const nin = $("nin").value.replace(/\\D/g, "");
  if (nin.length !== 11) return say("say1", "A NIN is 11 digits.", "err");
  if (!selfie) return say("say1", "Take a selfie first.", "err");
  $("go").disabled = true; say("say1", "Checking. This takes a few seconds…");
  const r = await post("/person", { nin, selfie });
  $("go").disabled = false;
  if (r.kind === "verified") return show("verified");
  if (r.kind === "business_needed") return show("person", r.accountName);
  say("say1", r.words, "err");
});

$("go2").addEventListener("click", async () => {
  const type = document.querySelector('input[name=type]:checked').value;
  const number = $("reg").value.trim();
  if (!number) return say("say2", "Enter the number on your CAC certificate.", "err");
  $("go2").disabled = true; say("say2", "Checking the CAC register…");
  const r = await post("/business", { number, type });
  $("go2").disabled = false;
  if (r.kind === "verified") return show("verified");
  if (r.kind === "review") return show("review");
  say("say2", r.words, "err");
});

$("mine").addEventListener("click", async () => {
  await post("/review", { note: "account is personal, name spelt differently" });
  show("review");
});
`;

export function identityPage(state: IdentityStatus, accountName: string | null): string {
  const s = state === "none" ? "none" : state;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="format-detection" content="telephone=no">
<title>Verify your identity · Balans</title>
<link rel="stylesheet" href="/designs/fonts.css">
<style>${CSS}</style></head>
<body>
<header class="top"><div class="in">
  <div class="brand">${darkLogo("26px")}</div>
  <h1>Get paid from abroad, safely</h1>
  <p>Verify once with your NIN and a selfie. Then your clients abroad can pay you by card, with no limits.</p>
</div></header>
<main class="wrap"><div class="card">

  <section id="person"${s === "none" ? "" : " hidden"}>
    <div class="step">
      <label for="nin">Your NIN</label>
      <input id="nin" type="text" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="11 digits">
      <p class="hint">The National Identification Number on your NIN slip or ID card.</p>
    </div>
    <div class="step">
      <label>A selfie</label>
      <div class="shot">
        <div class="face" id="face">☺</div>
        <button class="pill ghost" id="pick" type="button">Take a selfie</button>
        <input id="cam" type="file" accept="image/*" capture="user" hidden>
      </div>
      <p class="hint">Good light, facing the camera, no glasses or cap, just you.</p>
    </div>
    <button class="pill gold" id="go" type="button">Verify me</button>
    <p class="say" id="say1" role="status"></p>
  </section>

  <section id="business"${s === "person" ? "" : " hidden"}>
    <div class="step">
      <label>Your payout account is in the name <span id="acct">${esc(accountName ?? "")}</span></label>
      <p class="hint">If that's your business, give its CAC number. The register has to show the same business name, with you as a director, proprietor or partner.</p>
    </div>
    <div class="step">
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="type" value="COMPANY" checked><span>Limited company (RC)</span></label>
        <label><input type="radio" name="type" value="BUSINESS_NAME"><span>Business name (BN)</span></label>
      </div>
      <input id="reg" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 1234567">
    </div>
    <button class="pill gold" id="go2" type="button">Check the business</button>
    <p class="say" id="say2" role="status"></p>
    <button class="link" id="mine" type="button">It's my personal account, the name is just spelt differently</button>
  </section>

  <section id="verified" class="done"${s === "verified" ? "" : " hidden"}>
    <div class="tick">✓</div>
    <h2>You're verified</h2>
    <p>Invoice clients abroad with no limits. Go back to WhatsApp: if you were sending an invoice, it's there, ready to send.</p>
  </section>

  <section id="review" class="done"${s === "review" ? "" : " hidden"}>
    <h2>A person is looking at it</h2>
    <p>Something didn't line up automatically, so we'll check it by hand and message you on WhatsApp.</p>
  </section>

  <p class="fine">Your NIN and selfie are checked by Dojah, a licensed identity provider. We keep your NIN encrypted and never keep the selfie. It's used only to confirm who receives card payments from abroad.</p>
</div></main>
<script>${SCRIPT}</script>
</body></html>`;
}

const gone = (): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired · Balans</title><style>${CSS}</style></head><body><header class="top"><div class="in"><h1>This link has expired</h1><p>Send the invoice again in the chat and a new link comes with it.</p></div></header></body></html>`;

const VERIFIED_MESSAGE = lines(
  `✅ ${b("You're verified.")}`,
  "Your clients abroad can pay you by card, with no limits.",
);

/**
 * In the chat, once they pass: the invoice that sent them here, as a draft
 * with its buttons, or just the news when there was none. Imported when
 * needed, because the conversation code imports this file for its link.
 */
async function afterVerified(owner: { id: string; phone: string }, log: FastifyBaseLogger): Promise<void> {
  try {
    const { resumeAfterVerification } = await import("../../conversation/handle.ts");
    if (await resumeAfterVerification(owner.id, owner.phone, log)) return;
  } catch (e) {
    log.error({ userId: owner.id, err: (e as Error).message }, "could not bring the invoice back after verification");
  }
  await sendText(owner.phone, VERIFIED_MESSAGE).catch(() => {});
}

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  const headers = {
    "cache-control": "no-store, private",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  };

  app.get<{ Params: { token: string } }>("/verify/:token", async (req, reply) => {
    const owner = await ownerOfIdentityToken(req.params.token);
    if (!owner) return reply.status(404).type(HTML).headers(headers).send(gone());
    const { accountInForce } = await import("../../settings/bank-change.ts");
    const account = owner.status === "person" ? await accountInForce(owner.id) : null;
    return reply.type(HTML).headers(headers).send(identityPage(owner.status, account?.accountName ?? null));
  });

  app.post<{ Params: { token: string }; Body: { nin?: string; selfie?: string } }>(
    "/verify/:token/person",
    { bodyLimit: MAX_BODY },
    async (req, reply) => {
      const owner = await ownerOfIdentityToken(req.params.token);
      if (!owner) return reply.status(404).send({ ok: false, words: "This link has expired." });
      const out = await verifyPerson(owner.id, String(req.body?.nin ?? "").replace(/\D/g, ""), String(req.body?.selfie ?? ""), req.log);
      if (out.kind === "verified") void afterVerified(owner, req.log);
      return reply.headers(headers).send({
        ok: out.kind === "verified" || out.kind === "business_needed",
        kind: out.kind,
        words: PERSON_WORDS[out.kind],
        ...(out.kind === "business_needed" ? { accountName: out.accountName } : {}),
      });
    },
  );

  app.post<{ Params: { token: string }; Body: { number?: string; type?: string } }>(
    "/verify/:token/business",
    async (req, reply) => {
      const owner = await ownerOfIdentityToken(req.params.token);
      if (!owner) return reply.status(404).send({ ok: false, words: "This link has expired." });
      const type = req.body?.type === "BUSINESS_NAME" ? "BUSINESS_NAME" : "COMPANY";
      const out = await verifyBusiness(owner.id, String(req.body?.number ?? ""), type, req.log);
      if (out.kind === "verified") void afterVerified(owner, req.log);
      return reply.headers(headers).send({ ok: out.kind === "verified", kind: out.kind, words: BUSINESS_WORDS[out.kind] });
    },
  );

  app.post<{ Params: { token: string }; Body: { note?: string } }>("/verify/:token/review", async (req, reply) => {
    const owner = await ownerOfIdentityToken(req.params.token);
    if (!owner) return reply.status(404).send({ ok: false });
    await requestReview(owner.id, String(req.body?.note ?? ""), req.log);
    return reply.headers(headers).send({ ok: true });
  });
}
