/**
 * What the setup and bank forms actually do, once they are sure.
 *
 * These used to happen in the chat after a form closed: a code emailed and a
 * message saying so, a typed code, the terms as another form, and finally the
 * card. Four messages and a wait between each. From 1 October 2026 every one
 * of those is a billable service message, and the typed code was the step
 * people got lost on.
 *
 * So the form does them itself, through the endpoint, before it closes. It
 * ends on a screen that says it worked, and the chat has one message left to
 * send. The rules are the chat's rules — the same code table, the same email,
 * the same 24-hour bank delay and alert — called from here rather than
 * written twice.
 */

import type { FastifyBaseLogger } from "fastify";

import { env, legalConsentVersion } from "../../config.ts";
import { sendContactCard, sendText } from "../client.ts";
import { recordOutbound } from "../../conversation/store.ts";
import { db } from "../../db/pool.ts";
import { checkCode, issueCode } from "../../lib/codes.ts";
import { sendEmail, verificationEmail, welcomeEmail } from "../../email/send.ts";
import { displayNumber } from "../number.ts";
import {
  activateBankAccount,
  loadConversation,
  markEmailVerified,
  recordConsent,
  saveBankAccount,
  saveConversation,
  setBusinessName,
  setEmail,
} from "../../conversation/store.ts";
import {
  accountInForce,
  scheduleBankChange,
} from "../../settings/bank-change.ts";
import { raiseSecurityAlert } from "../../settings/alerts.ts";

export type Done = { ok: true } | { ok: false; message: string };

/** The account the bank named, as the endpoint kept it after "Check account". */
export type Checked = { bankCode: string; bankName: string; accountNumber: string; accountName: string };

/**
 * The welcome email, the first time somebody finishes signing up.
 *
 * Not awaited: the form is waiting on this answer, and a slow email provider
 * must not hold up the screen that says they are done. A welcome that fails
 * is logged and not retried, because a late welcome is worse than none.
 */
export function sendWelcome(
  userId: string,
  consent: Awaited<ReturnType<typeof recordConsent>>,
  log: FastifyBaseLogger,
): void {
  if (!consent.first) return;
  void sendSaveUs(userId, log);
  if (!consent.email) return;
  const to = consent.email;

  void (async () => {
    const sent = await sendEmail(
      { to, ...welcomeEmail({ businessName: consent.businessName, email: to, waNumber: await displayNumber() }) },
      log,
    );
    if (sent.ok) log.info({ userId, delivered: sent.delivered }, "welcome email sent");
    else log.warn({ userId, reason: sent.reason }, "welcome email not sent");
  })().catch((e) => log.error({ userId, err: (e as Error).message }, "welcome email failed"));
}

/**
 * "Save Balans", once, straight after setup: one line and our contact card.
 *
 * Until Meta grants a verified badge (it will not consider one before the
 * business is 30 days old), WhatsApp heads an unsaved business chat with the
 * number and shows "~Balans" small underneath. Saved, it says "Balans". This
 * is the only way to get there before the badge, and it is one tap.
 *
 * After the setup messages rather than among them: a short pause, so it
 * arrives last and reads as the aside it is. Never allowed to fail setup.
 */
async function sendSaveUs(userId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const [ours, { rows }] = await Promise.all([
      displayNumber(),
      db().query<{ wa_phone: string }>(`SELECT wa_phone FROM users WHERE id = $1`, [userId]),
    ]);
    const phone = rows[0]?.wa_phone;
    if (!ours || !phone) return;

    await new Promise((r) => setTimeout(r, 2500));
    const said = await sendText(phone, "📇 Save Balans to your contacts so we show up by name in your chats. Tap the card below, then *Add contact*.");
    if (said.ok) await recordOutbound(userId, said.waMessageId, "sent", { kind: "text" });

    const card = await sendContactCard(phone, {
      name: "Balans",
      waNumber: ours,
      email: env.SUPPORT_EMAIL,
      url: env.SITE_URL,
    });
    if (card.ok) {
      await recordOutbound(userId, card.waMessageId, "sent", { kind: "contacts" });
      log.info({ userId }, "contact card sent");
    } else {
      log.warn({ userId, reason: card.reason }, "contact card not sent");
    }
  } catch (e) {
    log.warn({ userId, err: (e as Error).message }, "contact card failed");
  }
}

async function emailCode(
  userId: string,
  purpose: "email_verify" | "bank_change",
  email: string,
  businessName: string | undefined,
  log: FastifyBaseLogger,
): Promise<Done> {
  const issued = await issueCode(userId, purpose, email);
  if (!issued.ok) {
    return { ok: false, message: `Too many codes just now. Wait ${issued.retryAfterMinutes} minutes, then tap Send a new code.` };
  }
  const sent = await sendEmail({ to: email, ...verificationEmail(issued.code, businessName) }, log);
  if (!sent.ok) {
    log.error({ userId, purpose, reason: sent.reason }, "could not email a code from a form");
    return { ok: false, message: "That email would not send. Go back to the first screen and check the address." };
  }
  return { ok: true };
}

/** A code that did not check out, in the words the chat has always used. */
function codeRefusal(check: { reason?: string; left?: number }): string {
  switch (check.reason) {
    case "expired":
      return "That code has expired. Tap Send a new code.";
    case "too_many_attempts":
      return "Too many tries on that code. Tap Send a new code.";
    case "no_code":
      return "There is no code waiting. Tap Send a new code.";
    default:
      return check.left
        ? `That code is not right. ${check.left} ${check.left === 1 ? "try" : "tries"} left.`
        : "That code is not right. Tap Send a new code.";
  }
}

/* -------------------------------------------------------------------------- */
/* Setting up, in the order the form asks (since 27 September 2026)          */
/* -------------------------------------------------------------------------- */

/*
 * Business and email, then the code from that email, then the bank, then the
 * terms. The code comes straight after the address because that is when the
 * person has just typed it and is ready to go and look; asking for it after
 * the bank was asking them to leave the form at the moment they were nearly
 * done.
 */

/** The first screen: the name on the invoices, and where the code goes. */
export async function startSetup(
  userId: string,
  input: { businessName: string; email: string },
  log: FastifyBaseLogger,
): Promise<Done> {
  await setBusinessName(userId, input.businessName);
  await setEmail(userId, input.email);
  log.info({ userId }, "setup form saved the business and asked for the code");
  return emailCode(userId, "email_verify", input.email, input.businessName, log);
}

/** The second: the code checked and the address proved. Nothing else yet. */
export async function verifySetupEmail(
  userId: string,
  email: string,
  code: string,
  log: FastifyBaseLogger,
): Promise<Done> {
  const check = await checkCode(userId, "email_verify", email, code);
  if (!check.ok) return { ok: false, message: codeRefusal(check) };
  await markEmailVerified(userId, email);
  log.info({ userId }, "setup form verified the email");
  return { ok: true };
}

/**
 * The last: "the details above are correct" and "I agree", both ticked.
 *
 * The account is the one the endpoint kept when the bank named it, never one
 * read back from the client. The terms are recorded here, at the end, so an
 * agreement is never on file for somebody who could not finish. And the
 * conversation goes to idle now rather than when the form closes: the last
 * screen can be dismissed without its button, and somebody who does that is
 * set up all the same.
 */
export async function completeSetup(userId: string, checked: Checked, log: FastifyBaseLogger): Promise<Done> {
  const { rows } = await db().query<{ verified: boolean }>(
    `SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows[0]?.verified) {
    return { ok: false, message: "Your email is not verified yet. Go back to the code screen." };
  }

  await saveBankAccount(userId, {
    bankCode: checked.bankCode,
    bankName: checked.bankName,
    accountNumber: checked.accountNumber,
    accountName: checked.accountName,
  });
  await activateBankAccount(userId, null);
  sendWelcome(userId, await recordConsent(userId, legalConsentVersion), log);

  const { context } = await loadConversation(userId);
  await saveConversation(userId, "idle", context.opener ? { opener: context.opener } : {});

  log.info({ userId, version: legalConsentVersion }, "set up entirely inside the form");
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Setting up, the order the 27 September morning form used                  */
/* -------------------------------------------------------------------------- */

/*
 * Kept for a form that may still be open on somebody's phone: it asked for
 * the bank before the code. Nothing new sends it.
 */

/**
 * "The details above are correct" and "I agree", both ticked.
 *
 * Saves what the form collected and emails the code. The account is the one
 * the endpoint kept when the bank named it, never one read back from the
 * client, and activated here exactly as the chat's "yes, that's me" did.
 */
export async function startOnboarding(
  userId: string,
  input: { businessName: string; email: string; checked: Checked },
  log: FastifyBaseLogger,
): Promise<Done> {
  await setBusinessName(userId, input.businessName);
  await saveBankAccount(userId, {
    bankCode: input.checked.bankCode,
    bankName: input.checked.bankName,
    accountNumber: input.checked.accountNumber,
    accountName: input.checked.accountName,
  });
  await activateBankAccount(userId, null);
  await setEmail(userId, input.email);
  log.info({ userId }, "setup form saved the business and the account");

  return emailCode(userId, "email_verify", input.email, input.businessName, log);
}

export async function resendOnboardingCode(
  userId: string,
  email: string,
  log: FastifyBaseLogger,
): Promise<Done> {
  const { rows } = await db().query<{ business_name: string | null }>(
    `SELECT business_name FROM users WHERE id = $1`,
    [userId],
  );
  return emailCode(userId, "email_verify", email, rows[0]?.business_name ?? undefined, log);
}

/**
 * The code checked, the email verified, the terms recorded.
 *
 * The terms were ticked two screens earlier, on the same form, and are
 * recorded only now that the address is proved — so an agreement is never on
 * file for somebody who could not finish.
 *
 * The conversation goes to idle here rather than when the form closes. The
 * last screen can be dismissed without tapping its button, and somebody who
 * does that is set up all the same; leaving them in `onboarding:form` would
 * read their next message as a business name.
 */
export async function finishOnboarding(
  userId: string,
  email: string,
  code: string,
  log: FastifyBaseLogger,
): Promise<Done> {
  const check = await checkCode(userId, "email_verify", email, code);
  if (!check.ok) return { ok: false, message: codeRefusal(check) };

  await markEmailVerified(userId, email);
  sendWelcome(userId, await recordConsent(userId, legalConsentVersion), log);

  const { context } = await loadConversation(userId);
  await saveConversation(userId, "idle", context.opener ? { opener: context.opener } : {});

  log.info({ userId, version: legalConsentVersion }, "set up entirely inside the form");
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Changing the bank (PRD F17)                                                */
/* -------------------------------------------------------------------------- */

/** "GTBank · ····6789 · ADA OKON", or a line saying there is none. */
export async function currentAccountLine(userId: string): Promise<string> {
  const now = await accountInForce(userId);
  return now ? `${now.bankName} · ····${now.last4} · ${now.accountName}` : "No payout account on file yet.";
}

/**
 * F17 step 1, asked for on the form: a code to the verified address.
 *
 * Without a verified email there is no second factor at all, and the change
 * cannot go ahead. The chat checks the same thing before it opens the form;
 * this is the check that holds if somebody reaches the screen another way.
 */
export async function sendChangeCode(
  userId: string,
  log: FastifyBaseLogger,
): Promise<{ ok: true; email: string } | { ok: false; message: string }> {
  const { rows } = await db().query<{ email: string | null; verified: boolean; business_name: string | null }>(
    `SELECT email, email_verified_at IS NOT NULL AS verified, business_name FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user?.verified || !user.email) {
    return { ok: false, message: "You need a verified email to change your bank. Email hello@balans.ng and a person will help." };
  }

  const sent = await emailCode(userId, "bank_change", user.email, user.business_name ?? undefined, log);
  if (!sent.ok) return sent;
  log.warn({ userId }, "bank change started from the form");
  return { ok: true, email: user.email };
}

/**
 * F17: the code, then the change made and the alert raised. It is in force
 * at once, open invoices included (see settings/bank-change.ts).
 */
export async function finishChange(
  userId: string,
  code: string,
  change: Checked,
  log: FastifyBaseLogger,
): Promise<{ ok: true; effectiveAt: Date } | { ok: false; message: string }> {
  const { rows } = await db().query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const check = await checkCode(userId, "bank_change", rows[0]?.email ?? "", code);
  if (!check.ok) return { ok: false, message: codeRefusal(check) };

  const effectiveAt = await scheduleBankChange(userId, { ...change, subAccountCode: null }, log);

  void raiseSecurityAlert(
    {
      userId,
      what: "your payout bank was changed",
      detail: [
        `New account: ${change.accountName} at ${change.bankName}, ending ${change.accountNumber.slice(-4)}.`,
        `It is in use now, including on invoices that are still unpaid.`,
      ],
      undoHint: "email hello@balans.ng straight away and we will lock your account.",
    },
    log,
  );

  return { ok: true, effectiveAt };
}
