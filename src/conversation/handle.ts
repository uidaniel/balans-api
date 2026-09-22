/**
 * Ties an inbound WhatsApp message to a reply.
 *
 *   inbound -> user -> current state -> machine -> effects -> replies -> saved
 *
 * The machine decides; this performs. Nothing here makes a product decision,
 * which is why the interesting logic stays testable without a database.
 */

import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { legalConsentVersion } from "../config.ts";
import { db, tx } from "../db/pool.ts";
import { markRead, sendButtons, sendText, type ReplyButton } from "../whatsapp/client.ts";
import {
  createSubAccount,
  initTransaction,
  listBanks,
  matchBank,
  payoutBlocked,
  resolveAccount,
} from "../payments/monnify.ts";
import { checkCode, issueCode } from "../lib/codes.ts";
import { sendEmail, transport, verificationEmail } from "../email/send.ts";
import { markEmailVerified, setEmail, recordConsent, saveBankAccount, activateBankAccount, getPendingBank } from "./store.ts";
import type { Inbound } from "../whatsapp/inbound.ts";
import { step, VOICE, type Effect, type PendingDoc, type State } from "./machine.ts";
import { splitForPlan } from "../whatsapp/flows/definitions.ts";
import { VAT_PERCENT } from "../parser/extract.ts";
import { parseAmountToKobo } from "../../core/amount.ts";
import { forLog, type Parsed } from "../parser/schema.ts";
import { b, i, lines, para, row } from "../whatsapp/format.ts";
import { parseMessage } from "../parser/parse.ts";
import { readCorrection } from "../parser/corrections.ts";
import { asCommand } from "../parser/commands.ts";
import { resolveDueDate, todayIn, type Civil } from "../../core/dates.ts";
import { defaults, env } from "../config.ts";
import { confirmDraft, createDraft, discardDraft, getOpenDraft } from "../documents/store.ts";
import { draftButtons, draftSummary, sentMessage } from "../documents/summary.ts";
import { pickerUrlFor } from "../http/routes/templates.ts";
import { clearLogo, saveLogo } from "../brand/user-logo.ts";
import { debtors, documentsThisMonth, findDocument, planOf, summarise } from "../documents/queries.ts";
import {
  cancelledMessage,
  cannotCancelMessage,
  cannotConvertMessage,
  convertedMessage,
  debtorsMessage,
  limitReachedMessage,
  notFoundMessage,
  remindersStoppedMessage,
  resendMessage,
  statusMessage,
  summaryMessage,
} from "../documents/reports.ts";
import { defaultPeriod, readPeriod } from "../../core/period.ts";
import { renderDocumentPdf } from "../documents/pdf.ts";
import { emailDocumentToClient } from "../email/client-delivery.ts";
import { cancelDocument, convertQuote, findForResend, stopReminders } from "../documents/actions.ts";
import {
  accountInForce,
  cancelPendingChange,
  pendingChange,
  scheduleBankChange,
  CHANGE_DELAY_HOURS,
} from "../settings/bank-change.ts";
import { raiseSecurityAlert } from "../settings/alerts.ts";
import { attachPaymentReference, openSubscription, stateOf } from "../billing/subscription.ts";
import { deductChosen, payLinkMessage, proActive, proOffer, proOfferButtons } from "../billing/messages.ts";
import { settingsMenu, settingsList, bankChangeScheduled, deletionStarted } from "../settings/messages.ts";
import { sendCta, sendFlow, sendList } from "../whatsapp/client.ts";
import { flowId } from "../whatsapp/flows/register.ts";

/** The screen each Flow opens on. */
const FLOW_SCREEN = {
  onboarding: "BUSINESS",
  business_details: "DETAILS",
  invoice: "WORK",
} as const;
import { OTHER_BANK } from "../whatsapp/flows/banks.ts";
import { sendDocument, uploadDocument } from "../whatsapp/client.ts";
import {
  loadConversation,
  recordInbound,
  hasChosenTemplate,
  recordOutbound,
  saveConversation,
  setBusinessName,
  upsertUser,
} from "./store.ts";

export async function handleInbound(msg: Inbound, log: FastifyBaseLogger): Promise<void> {
  const user = await upsertUser(msg.from);

  /*
   * Both of these need the user and neither needs the other, so they go
   * together. The database is in Ireland and the server is not, which puts
   * about 160ms on every round trip — sequencing two independent reads costs
   * a fifth of a second of pure waiting, and a turn only has a handful of
   * those to spend.
   *
   * On a redelivery this reads a conversation it then throws away. That is a
   * wasted read on the rare path to save a round trip on the common one.
   */
  const [first, saved] = await Promise.all([
    // Meta redelivers on any doubt. Storing the id first means a repeat stops
    // here rather than producing a second reply to the same sentence.
    recordInbound(user.id, msg.waMessageId, msg.kind),
    loadConversation(user.id),
  ]);

  if (!first) {
    log.info({ waMessageId: msg.waMessageId }, "duplicate delivery ignored");
    return;
  }

  if (user.status === "closed") {
    log.warn({ userId: user.id }, "message from a closed account, ignored");
    return;
  }

  // Blue ticks and the typing bubble, before the thinking starts. Not awaited:
  // it is decoration, and the reply must not wait on a read receipt.
  void markRead(msg.waMessageId, { typing: true });

  // A paused account is paused whatever the conversation last said.
  const state: State = user.status === "paused" ? "paused" : saved.state;

  /*
   * Somebody opened the chat and has not said anything yet.
   *
   * There is no message to parse and no state to advance: this is the one
   * moment to say what the product is, to a person looking at an empty screen
   * who was probably just handed the number by somebody else.
   */
  if (msg.kind === "welcome") {
    await reply(user.id, msg.from, [state === "new" ? VOICE.askBusinessName : VOICE.helpIdle], log);
    return;
  }

  /*
   * An image is a logo (F21).
   *
   * Handled before the machine rather than as a state, because it arrives
   * unannounced: nobody is asked to send a logo, they just send one, and the
   * only sensible reading of a picture sent to an invoicing bot is "put this
   * on my invoices". Dealt with here it also cannot disturb a draft somebody
   * is halfway through confirming.
   */
  if (msg.kind === "image" && msg.mediaId) {
    await handleLogo(user.id, msg.mediaId, msg.from, log);
    return;
  }

  /*
   * A submitted form.
   *
   * Handled before the machine, like an image is, because it arrives as a
   * whole set of answers at once rather than as the reply to the question the
   * conversation happens to be on. Its `flow_token` says which form it was and
   * who it belongs to — checked against this user, because the token travels
   * through the client and nothing that comes back from there is trusted.
   */
  if (msg.flow) {
    const [key, tokenUser] = msg.flow.token.split(":");
    if (tokenUser !== user.id) {
      log.warn({ userId: user.id, tokenUser }, "flow token does not match the sender");
      return;
    }
    if (key === "onboarding") {
      await handleOnboardingForm(user.id, msg.from, msg.flow.fields, log);
      return;
    }
    if (key === "business_details") {
      await handleDetailsForm(user.id, msg.from, msg.flow.fields, log);
      return;
    }
    if (key === "invoice") {
      await handleInvoiceForm(
        user.id,
        msg.from,
        msg.flow.fields,
        user.businessName ?? undefined,
        log,
        todayIn(defaults.behaviour.timezone),
      );
      return;
    }
    log.warn({ userId: user.id, key }, "a form we do not know");
    return;
  }

  // Anything else that is not text has no words to act on yet. Say so rather
  // than letting it fall through the machine as an empty message.
  if (msg.kind !== "text" && msg.kind !== "interactive" && !msg.text) {
    await reply(
      user.id,
      msg.from,
      [
        para(
          `📎 ${b("I can only read text and images.")}`,
          "Send me a line like " + i("Invoice Tunde 20k for logo design") + ".",
        ),
      ],
      log,
    );
    return;
  }

  const today = todayIn(defaults.behaviour.timezone);
  const text = msg.text ?? "";

  // The parser runs here, not in the machine: it is asynchronous and the
  // machine is a pure function. Only the states that can act on a parse pay
  // for one — onboarding answers are a bank number and an email, and putting
  // those through a model would cost money to learn nothing.
  /*
   * A correction is read before the model, not after it.
   *
   * With a draft on screen, "make it 400k" and "due friday" are the two most
   * common things anybody types, and `readCorrection` understands both for
   * nothing. Asking the model first cost between one and five seconds to be
   * told "unknown", and then the correction reader answered it anyway — a
   * whole model call spent on a question we had already answered.
   *
   * The command check comes first of all, so "yes" and "no" are never mistaken
   * for a correction.
   */
  const correction =
    state === "awaiting_confirm" && !asCommand(text) ? readCorrection(text, today) : null;

  // Nothing left to work out: the correction is the whole message.
  const needsParse = NEEDS_PARSE.has(state) && !correction;
  const reading = needsParse ? await parseMessage(text, { today }) : null;

  /*
   * Section 5: "A new command always wins over a pending question, so users
   * are never trapped."
   *
   * The settings and onboarding steps do not run the parser — their answers
   * are a bank number or a menu choice, and a model call would cost money to
   * learn nothing. But somebody halfway through settings who types "who owes
   * me" still means it, so the free command check runs even there.
   */
  const escaping = !needsParse ? asCommand(text) : null;

  const result = step(
    state,
    saved.context,
    {
      text,
      profileName: msg.profileName,
      today,
      parsed: reading?.ok
        ? reading.parsed
        : escaping
          ? commandAsParsed(escaping)
          : undefined,
      parseFailed: reading && !reading.ok ? reading.reason : undefined,
      correction,
    },
    legalConsentVersion,
  );

  if (reading) {
    log.info(
      { userId: user.id, state, ...(reading.ok ? forLog(reading.parsed) : { failed: reading.reason }), latencyMs: reading.latencyMs },
      "parsed",
    );
  }

  // Out before the work, so a bank lookup or a code check is not a silent gap.
  if (result.ack?.length) await reply(user.id, msg.from, result.ack, log);

  const outcome = await runEffects(result.effects, user.id, result.context.businessName, log, {
    draftId: saved.context.draftId,
    today,
    text,
    parsed: reading?.ok ? reading.parsed : undefined,
    phone: msg.from,
    changing: saved.context.changing as never,
  });

  // An effect can refuse to let the conversation move on: a wrong code must not
  // reach the consent step just because the machine hoped it would. A faulted
  // effect goes further and stays where it started, because the state it was
  // heading for assumes work that may not have happened.
  const next = outcome.failed ? state : (outcome.holdAt ?? result.next);

  // And when it refuses, the machine's own replies describe a future that did
  // not happen. Sending them anyway produces the worst kind of message pair -
  // "what is your email?" immediately followed by "I could not set up your
  // payouts" — so the effect's account of events replaces them.
  const replies =
    outcome.holdAt || outcome.failed ? outcome.lines : [...result.replies, ...outcome.lines];

  // The resolved name is what the next turn asks them to confirm.
  let context = outcome.resolvedName
    ? { ...result.context, resolvedAccountName: outcome.resolvedName }
    : result.context;

  // A draft only has an id once it has been written, so the id comes back out
  // of the effect rather than going in with it.
  if (outcome.draftId) context = { ...context, draftId: outcome.draftId };
  if (outcome.pendingBankChange) context = { ...context, changing: outcome.pendingBankChange };
  if (outcome.clearDraft) {
    const { doc: _doc, draftId: _id, ...rest } = context;
    context = rest;
  }

  // The effect owns the last message when it added lines, so its buttons win.
  // When an effect held or faulted, the machine's question was never asked and
  // its buttons would answer nothing.
  const buttons =
    outcome.buttons ?? (outcome.holdAt || outcome.failed ? undefined : result.buttons);

  await saveConversation(user.id, next, context);
  await reply(user.id, msg.from, replies, log, buttons);

  log.info(
    { userId: user.id, from: state, to: next, effects: result.effects.map((e) => e.type) },
    "conversation advanced",
  );
}

/**
 * Performs what the machine asked for.
 *
 * Several of these depend on parts that do not exist yet. Rather than fail
 * silently or pretend, each returns a line saying plainly where it stops —
 * the design system's rule is that we never promise what the product cannot
 * do yet.
 */
type EffectOutcome = {
  lines: string[];
  holdAt?: State;
  /**
   * An effect threw.
   *
   * Distinct from `holdAt`, which is a deliberate refusal with something to
   * say. This is a fault: the conversation stays exactly where it was, because
   * we do not know how much of the work happened.
   */
  failed?: true;
  resolvedName?: string;
  /** Set by save_draft, so the next turn knows which row "yes" refers to. */
  draftId?: string;
  /** Set once a draft is gone, so the conversation stops pointing at it. */
  clearDraft?: boolean;
  /**
   * Tappable answers for the last line this effect produced.
   *
   * Needed here as well as on the machine's `Step` because an effect's lines
   * come after the machine's, so an effect that ends in a question — the draft
   * summary asking "Send it?" — owns the last message of the turn.
   */
  buttons?: ReplyButton[];
  /** A resolved bank change, waiting on the user's yes. */
  pendingBankChange?: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    subAccountCode: string;
  };
};

/**
 * The states where a message is worth reading.
 *
 * Everything else is answering a specific question with a specific thing, and
 * a parse would cost a model call to be told what we already knew.
 */
const NEEDS_PARSE = new Set<State>([
  "idle",
  "awaiting_confirm",
  "awaiting_field:client_name",
  "awaiting_field:amount",
  "awaiting_field:description",
  "awaiting_field:due_date",
]);

/** Intents that mean "forget the draft and do this instead". */
const ACTIONS = new Set([
  "confirm", "reject", "debtors", "summary", "settings", "upgrade", "referral",
  "status", "cancel_document", "resend_document", "convert_quote",
  "create_invoice", "create_quote",
]);

async function runEffects(
  effects: Effect[],
  userId: string,
  businessName: string | undefined,
  log: FastifyBaseLogger,
  ctx: {
    draftId?: string;
    today: Civil;
    /** The message as sent, for the period in "how did I do last month?". */
    text?: string;
    parsed?: Parsed;
    /** Where to send a file, which does not go through the reply path. */
    phone?: string;
    /** A bank change resolved on the previous turn, waiting on a yes (F17). */
    changing?: {
      bankCode: string;
      bankName: string;
      accountNumber: string;
      accountName: string;
      subAccountCode: string;
    };
  } = { today: { y: 1970, m: 1, d: 1 } },
): Promise<EffectOutcome> {
  const extra: string[] = [];
  let holdAt: State | undefined;
  let failed: true | undefined;
  /** A bank change resolved this turn, handed to the next one via context. */
  let pendingBankChange: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    subAccountCode: string;
  } | undefined;
  // The bank's answer, so the machine's context carries it into the next turn.
  let resolvedName: string | undefined;
  let draftId: string | undefined;
  /** Tappable answers for the last line an effect pushed into `extra`. */
  let buttons: ReplyButton[] | undefined;
  let clearDraft: boolean | undefined;

  for (const effect of effects) {
    // Once something has held the conversation, the effects after it are acting
    // on a premise that no longer holds — and one of them posts a real email.
    if (holdAt) break;

    /*
     * A throw in here used to reach the webhook's catch, which logged it and
     * returned. The user got no reply at all, the conversation was never
     * saved, and their next message met the same question again — which is
     * exactly how a scheduled bank change turned into an endless loop of
     * "Is this the right account?".
     *
     * So a fault is caught where it happens, said out loud, and the
     * conversation is left standing still rather than silently abandoned.
     */
    try {
      switch (effect.type) {
        case "show_help":
          break;

        case "resolve_account": {
          // F17: the name comes from the bank, never from the user. It is what
          // they confirm, and what the name check in F26 compares against.
          const banks = await listBanks();
          const bank = matchBank(effect.bankQuery, banks);

          if (!bank) {
            extra.push(
              lines(
                `🤔 I do not recognise ${b(effect.bankQuery)} as a bank.`,
                `Send the bank and account number again — like ${b("GTBank 0123456789")}.`,
              ),
            );
            holdAt = "onboarding:bank";
            break;
          }


          // Said before the name check, not after it. Learning that an account
          // cannot be paid into is bad news either way; hearing it after you
          // have confirmed your own name is worse, and costs two more messages.
          const blocked = payoutBlocked(bank.code);
          if (blocked) {
            log.info({ userId, bank: bank.name }, "payout-blocked bank offered");
            extra.push(
              para(
                `⛔ ${b(`${blocked} cannot receive payouts yet.`)}`,
                lines(
                  "Our payments provider will not settle into wallet accounts like",
                  `${b("OPay")}, ${b("PalmPay")} or ${b("Moniepoint")} — we are working on it.`,
                ),
                `Send a regular bank account instead — like ${b("GTBank 0123456789")}.`,
              ),
            );
            holdAt = "onboarding:bank";
            break;
          }
          const resolved = await resolveAccount(effect.accountNumber, bank.code);

          if (!resolved.ok) {
            log.warn({ userId, reason: resolved.reason }, "account resolution failed");
            extra.push(
              resolved.reason === "invalid_details"
                ? lines(
                    `${bank.name} did not recognise ${b(effect.accountNumber)}.`,
                    "Check the number and send it again.",
                  )
                : "I could not reach the bank just now. Send it again in a moment.",
            );
            holdAt = "onboarding:bank";
            break;
          }

          // Stored pending; it only becomes active once they confirm the name.
          await saveBankAccount(userId, {
            bankCode: bank.code,
            bankName: bank.name,
            accountNumber: effect.accountNumber,
            accountName: resolved.account.accountName,
          });

          resolvedName = resolved.account.accountName;
          extra.push(
            para(
              `🏦 That account is ${b(resolved.account.accountName)} at ${bank.name}.`,
              lines(
                `If that is right, ${b("send your email address")} — receipts and invoice copies go there.`,
                `If it is not, reply ${b("no")}.`,
              ),
            ),
          );
          break;
        }

        case "create_subaccount": {
          const pending = await getPendingBank(userId);
          if (!pending) {
            log.error({ userId }, "confirmed an account that is not on file");
            extra.push(
              lines(
                "⚠️ Something went wrong saving that account.",
                "Send the bank and number again.",
              ),
            );
            holdAt = "onboarding:bank";
            break;
          }

          const created = await createSubAccount({
            accountNumber: pending.accountNumber,
            bankCode: pending.bankCode,
            email: pending.email ?? `${userId}@users.balans.ng`,
          });

          if (!created.ok) {
            await flagSetupForReview(userId, created.message, log);
            const tries = await countSetupFailures(userId);
            log.error(
              { userId, message: created.message, retryable: created.retryable, tries },
              "subaccount creation failed",
            );

            // F1: after three failures, stop asking and hand it to a person.
            // Repeating a question somebody has already answered correctly three
            // times is the worst thing a setup flow can do to them.
            if (tries >= 3) {
              extra.push(
                para(
                  `🙋 ${b("I cannot set that account up for payouts.")}`,
                  lines(
                    `Email ${b("hello@balans.ng")} and a person will finish it with you — usually the same day.`,
                    "Nothing you have told me is lost.",
                  ),
                ),
              );
              holdAt = "onboarding:bank";
              break;
            }

            extra.push(
              created.retryable
                ? lines(
                    "⏳ Our payments provider is not answering just now.",
                    `Reply ${b("yes")} to try that account again.`,
                  )
                : para(
                    b("That account cannot receive payouts."),
                    lines(
                      "Some fintech and wallet accounts are not supported yet.",
                      `Send a ${b("regular bank account")} instead — like ${b("GTBank 0123456789")}.`,
                    ),
                  ),
            );
            holdAt = created.retryable ? "onboarding:confirm_account" : "onboarding:bank";
            break;
          }

          await activateBankAccount(userId, created.account.subAccountCode);
          log.info(
            { userId, subAccount: created.account.subAccountCode, reused: created.reused ?? false },
            created.reused ? "reused an existing subaccount" : "subaccount created",
          );
          break;
        }

        case "send_flow": {
          const id = await flowId(effect.key);

          /*
           * No published flow means no form. That is a configuration state,
           * not a user's problem: fall back to the typed questions, which are
           * still there and still work.
           *
           * It is also the state this account is in until the business is
           * verified — Meta refuses to publish a Flow before then — so this
           * branch is the live path today, not a theoretical one.
           */
          if (!id) {
            log.warn({ userId, key: effect.key }, "no published flow, asking in words");
            extra.push(effect.fallback?.line ?? VOICE.setupByHand);
            holdAt =
              effect.fallback?.holdAt ??
              (effect.key === "onboarding" ? "onboarding:business_name" : "idle");
            break;
          }

          if (!ctx.phone) {
            log.error({ userId }, "no phone on the effect context, cannot send a flow");
            extra.push(effect.fallback?.line ?? VOICE.setupByHand);
            holdAt = effect.fallback?.holdAt ?? "onboarding:business_name";
            break;
          }

          const sent = await sendFlow(ctx.phone, {
            body: effect.body,
            cta: effect.cta,
            flowId: id,
            // Ties the submission back to this person. Read on the way in, and
            // never trusted for anything the sender could have chosen.
            token: `${effect.key}:${userId}`,
            screen: FLOW_SCREEN[effect.key],
            data: effect.key === "business_details" ? await detailsFor(userId) : undefined,
            // A draft flow opens for anyone with developer access to the app,
            // which is how this is tested before verification comes through.
            draft: env.WA_FLOWS_DRAFT === "true",
          });

          if (sent.ok) {
            await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
          } else {
            log.error({ userId, reason: sent.reason }, "flow send failed");
            extra.push(effect.fallback?.line ?? VOICE.setupByHand);
            holdAt =
              effect.fallback?.holdAt ??
              (effect.key === "onboarding" ? "onboarding:business_name" : "idle");
          }
          break;
        }

        case "send_email_code": {
          await setEmail(userId, effect.email);
          const issued = await issueCode(userId, "email_verify", effect.email);

          if (!issued.ok) {
            extra.push(
              lines(
                "🛑 That is a lot of codes in a short time.",
                `Wait ${b(`${issued.retryAfterMinutes} minutes`)} and reply ${b("resend")}.`,
              ),
            );
            holdAt = "onboarding:verify_email";
            break;
          }

          const sent = await sendEmail(
            { to: effect.email, ...verificationEmail(issued.code, businessName) },
            log,
          );

          if (!sent.ok) {
            log.error({ userId, reason: sent.reason }, "could not send the verification code");
            extra.push(
              lines(
                `✉️ That email would not send — check the address.`,
                `Or reply ${b("change")} to use another one.`,
              ),
            );
            holdAt = "onboarding:verify_email";
            break;
          }

          // Without a provider the code only reached the server log, so say so
          // rather than leaving someone waiting on an email that is not coming.
          if (!sent.delivered) {
            extra.push(
              "Email sending is not connected on this environment yet, so the code is in the server log.",
            );
          }
          break;
        }

        case "verify_email_code": {
          const check = await checkCode(userId, "email_verify", effect.email, effect.code);

          if (check.ok) {
            await markEmailVerified(userId, effect.email);
            // The machine moved to consent but has nothing to say about it: only
            // this branch knows the code was right. Without this the flow ends in
            // silence at the last step.
            extra.push(VOICE.confirmedAskConsent);
            buttons = VOICE.consentButtons();
            break;
          }

          // Hold the conversation where it was; the machine had hoped to move on.
          holdAt = "onboarding:verify_email";
          switch (check.reason) {
            case "expired":
              extra.push(`⌛ ${b("That code has expired.")}`);
              break;
            case "too_many_attempts":
              extra.push(`🛑 ${b("Too many tries on that code.")}`);
              break;
            case "no_code":
              extra.push(`🤔 ${b("I have no code waiting for that address.")}`);
              break;
            default:
              extra.push(
                check.left
                  ? lines(
                      `❌ ${b("That code is not right.")}`,
                      `${check.left} ${check.left === 1 ? "try" : "tries"} left.`,
                    )
                  : `❌ ${b("That code is not right.")}`,
              );
          }
          // Every branch here is a dead end without a way out, and the way out
          // is the same two taps in all of them.
          buttons = VOICE.codeButtons();
          break;
        }

        case "record_consent":
          await recordConsent(userId, effect.version);
          log.info({ userId, version: effect.version }, "consent recorded");
          break;

        /* -- Documents (F6) ------------------------------------------------- */

        case "save_draft": {
          const doc = effect.doc;

          // F6: plan limits are checked before the draft is shown. Drafting
          // something and refusing to send it afterwards would be worse than
          // saying so now, because by then they have read and approved it.
          // Independent of each other, and both are needed before anything
          // can be drafted. Another 160ms round trip saved.
          const [plan, used] = await Promise.all([
            planOf(userId),
            documentsThisMonth(userId, ctx.today),
          ]);
          const limit = defaults.plans[plan].documentsPerMonth;
          if (limit !== null) {
            if (used >= limit) {
              log.info({ userId, used, limit, plan }, "monthly document limit reached");
              extra.push(limitReachedMessage(used, limit));
              holdAt = "idle";
              break;
            }
          }

          const draft = await createDraft(userId, {
            type: doc.type,
            clientName: doc.clientName ?? "",
            clientEmail: doc.clientEmail ?? null,
            lines: doc.lines,
            dueDate: doc.dueDate ?? null,
            vatPercent: doc.vatPercent ?? null,
            depositPercent: doc.depositPercent ?? null,
            instalments: doc.instalments ?? null,
            passFeesToClient: doc.passFeesToClient ?? false,
            notes: doc.notes ?? null,
          });
          draftId = draft.id;
          extra.push(draftSummary(draft, ctx.today));
          buttons = draftButtons();
          log.info({ userId, draftId: draft.id, totalKobo: draft.totalKobo }, "draft saved");
          break;
        }

        case "send_document": {
          // Read it back rather than trusting the conversation: what goes out
          // must be the row the summary was rendered from.
          const draft = await getOpenDraft(userId);
          if (!draft || draft.id !== ctx.draftId) {
            log.warn({ userId, draftId: ctx.draftId }, "nothing to send");
            extra.push("📭 That draft is no longer waiting. Send me the details again.");
            clearDraft = true;
            break;
          }

          const confirmed = await confirmDraft(userId, draft.id);
          if (!confirmed) {
            extra.push("⚠️ I could not send that just now. Try again in a moment.");
            holdAt = "awaiting_confirm";
            break;
          }

          clearDraft = true;
          log.info(
            { userId, documentId: confirmed.id, number: confirmed.number, type: confirmed.type },
            "document sent",
          );

          // F21: if the client's email is known, the invoice goes to their
          // inbox too. Not awaited — the user is waiting on their own message,
          // and a slow mail provider must not hold it up.
          void emailDocumentToClient(confirmed.id, log).then((r) => {
            if (!r.ok && r.why !== "no_client_email" && r.why !== "not_pro") {
              log.error({ documentId: confirmed.id, why: r.why }, "client delivery failed");
            }
          });

          // F6 step 4: one message with the PDF and the link, ready to forward.
          // The caption carries the words, so the file and the message are one
          // bubble rather than two.
          const { forward } = sentMessage(draft, confirmed, env.PUBLIC_BASE_URL, ctx.today);
          const pdf = await renderDocumentPdf(confirmed.id, log);

          /*
           * The design picker, once.
           *
           * It used to ride on the note as a button, which was free because the
           * note was a message anyway. The note is now in the caption, so this
           * is the only thing that would cost an extra send — and it is offered
           * to somebody who has never chosen a design, which happens once in
           * the life of an account. Afterwards `/design` is the way in.
           */
          const offerDesigns = async (): Promise<void> => {
            if (!ctx.phone || (await hasChosenTemplate(userId))) return;

            const cta = await sendCta(ctx.phone, {
              body: "🎨 Want your invoices to look different? Pick a design.",
              label: "See designs",
              url: await pickerUrlFor(userId, env.PUBLIC_BASE_URL),
              footer: "Takes a moment, and it sticks",
            });

            if (cta.ok) {
              await recordOutbound(userId, cta.waMessageId, "sent", { kind: "interactive" });
              return;
            }
            log.warn({ userId, reason: cta.reason }, "could not send the design button");
          };

          if (pdf && ctx.phone) {
            const up = await uploadDocument(pdf.bytes, pdf.filename);
            if (up.ok) {
              const sent = await sendDocument(ctx.phone, up.mediaId, pdf.filename, forward);
              if (sent.ok) {
                await recordOutbound(userId, sent.waMessageId, "sent", { kind: "document" });
                await offerDesigns();
                break;
              }
              log.error({ userId, reason: sent.reason }, "could not send the document");
            } else {
              log.error({ userId, reason: up.reason }, "could not upload the document");
            }
          }

          // No renderer, no upload, or a failed send: the link still works, and
          // that is the part that gets them paid.
          extra.push(forward);
          await offerDesigns();
          break;
        }

        case "discard_draft":
          await discardDraft(userId);
          clearDraft = true;
          break;

        /* -- Not built yet, and said so rather than left silent -------------- */

        case "show_debtors": {
          extra.push(debtorsMessage(await debtors(userId, ctx.today), ctx.today));
          break;
        }

        case "show_summary": {
          // The period comes from their words, not the model: a summary that
          // adds up the wrong days is worse than one that asks.
          const period = readPeriod(ctx.text ?? "", ctx.today) ?? defaultPeriod(ctx.today);
          extra.push(summaryMessage(await summarise(userId, period, ctx.today)));
          break;
        }

        case "remove_logo": {
        await clearLogo(userId);
        extra.push(
          lines(
            `🧽 ${b("Logo removed.")}`,
            "Your invoices go out without it from now on. Send an image any time to put one back.",
          ),
        );
        break;
      }

      case "show_designs": {
          // A button rather than a pasted URL: the picker is the whole point,
          // and it should be one tap from the words describing it.
          if (ctx.phone) {
            const sent = await sendCta(ctx.phone, {
              body: VOICE.designs,
              label: "See designs",
              url: await pickerUrlFor(userId, env.PUBLIC_BASE_URL),
              footer: "Your current one is marked",
            });
            if (sent.ok) {
              await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
              break;
            }
            log.error({ userId, reason: sent.reason }, "could not send the design link");
          }

          extra.push(`${VOICE.designs}

  ${await pickerUrlFor(userId, env.PUBLIC_BASE_URL)}`);
          break;
        }

        case "show_settings": {
          const [account, pending] = await Promise.all([
            accountInForce(userId),
            pendingChange(userId),
          ]);

          // A tappable list rather than "reply with a number". One tap cannot be
          // mistyped, and it shows what each option does without a wall of text.
          if (ctx.phone) {
            const sent = await sendList(ctx.phone, settingsList({ businessName, account, pending }));
            if (sent.ok) {
              await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
              break;
            }
            log.error({ userId, reason: sent.reason }, "settings list failed; falling back to text");
          }

          extra.push(settingsMenu({ businessName, account, pending }));
          break;
        }

        /* -- Settings (F17) ------------------------------------------------- */

        case "set_business_name":
          await setBusinessName(userId, effect.name);
          extra.push(`✅ Your business is now ${b(effect.name)}.`);
          log.info({ userId }, "business name changed");
          break;

        case "set_due_days":
          await db().query(`UPDATE users SET default_due_days = $2 WHERE id = $1`, [
            userId,
            effect.days,
          ]);
          extra.push(
            effect.days === 0
              ? `✅ New invoices will be ${b("due on receipt")}.`
              : `✅ New invoices will be due in ${b(`${effect.days} days`)}.`,
          );
          break;

        case "send_bank_change_code": {
          // The code goes to the verified email, which is the factor the phone
          // does not control. Without one there is no second factor at all, and
          // the change simply cannot proceed.
          const { rows } = await db().query<{ email: string | null; verified: boolean }>(
            `SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1`,
            [userId],
          );
          const email = rows[0]?.verified ? rows[0]?.email : null;

          if (!email) {
            extra.push(
              para(
                b("You need a verified email before you can change your bank."),
                "It is what we send the security code to.",
                `Email ${b("hello@balans.ng")} and a person will help.`,
              ),
            );
            holdAt = "idle";
            break;
          }

          const issued = await issueCode(userId, "bank_change", email);
          if (!issued.ok) {
            extra.push(
              lines(
                "🛑 That is a lot of codes in a short time.",
                `Wait ${b(`${issued.retryAfterMinutes} minutes`)} and try again.`,
              ),
            );
            holdAt = "idle";
            break;
          }

          const sent = await sendEmail(
            { to: email, ...verificationEmail(issued.code, businessName) },
            log,
          );
          if (!sent.ok) {
            extra.push("⚠️ I could not send that code. Try again in a moment.");
            holdAt = "idle";
            break;
          }

          log.warn({ userId }, "bank change started");
          extra.push(VOICE.askBankChangeCode);
          break;
        }

        case "verify_bank_change_code": {
          const { rows } = await db().query<{ email: string | null }>(
            `SELECT email FROM users WHERE id = $1`,
            [userId],
          );
          const check = await checkCode(userId, "bank_change", rows[0]?.email ?? "", effect.code);

          if (!check.ok) {
            holdAt = "settings:bank_code";
            extra.push(
              check.reason === "expired"
                ? "That code has expired. Reply *change bank* to start again."
                : check.left
                  ? `That code is not right. ${check.left} ${check.left === 1 ? "try" : "tries"} left.`
                  : "That code is not right. Reply *change bank* to start again.",
            );
            break;
          }

          extra.push(VOICE.askNewBank);
          break;
        }

        case "resolve_new_account": {
          const banks = await listBanks();
          const bank = matchBank(effect.bankQuery, banks);
          if (!bank) {
            extra.push(
              lines(
                `🤔 I do not recognise ${b(effect.bankQuery)} as a bank.`,
                `Send it again — like ${b("GTBank 0123456789")}.`,
              ),
            );
            holdAt = "settings:bank_details";
            break;
          }


          // Said before the name check, not after it. Learning that an account
          // cannot be paid into is bad news either way; hearing it after you
          // have confirmed your own name is worse, and costs two more messages.
          const blocked = payoutBlocked(bank.code);
          if (blocked) {
            log.info({ userId, bank: bank.name }, "payout-blocked bank offered");
            extra.push(
              para(
                `⛔ ${b(`${blocked} cannot receive payouts yet.`)}`,
                lines(
                  "Our payments provider will not settle into wallet accounts like",
                  `${b("OPay")}, ${b("PalmPay")} or ${b("Moniepoint")} — we are working on it.`,
                ),
                `Send a regular bank account instead — like ${b("GTBank 0123456789")}.`,
              ),
            );
            holdAt = "settings:bank_details";
            break;
          }
          const resolved = await resolveAccount(effect.accountNumber, bank.code);
          if (!resolved.ok) {
            extra.push(
              resolved.reason === "invalid_details"
                ? lines(
                    `${bank.name} did not recognise ${b(effect.accountNumber)}.`,
                    "Check the number and send it again.",
                  )
                : "I could not reach the bank just now. Send it again in a moment.",
            );
            holdAt = "settings:bank_details";
            break;
          }

          // The subaccount is created now, so that committing is only a
          // scheduling decision and cannot fail halfway.
          const created = await createSubAccount({
            accountNumber: effect.accountNumber,
            bankCode: bank.code,
            email: `${userId}@users.balans.ng`,
          });
          if (!created.ok) {
            log.error({ userId, message: created.message }, "new subaccount failed");
            extra.push(
              created.retryable
                ? "Our payments provider is not answering. Send the details again in a moment."
                : para(
                    b("That account cannot receive payouts."),
                    `Send a ${b("regular bank account")} instead.`,
                  ),
            );
            holdAt = "settings:bank_details";
            break;
          }

          pendingBankChange = {
            bankCode: bank.code,
            bankName: bank.name,
            accountNumber: effect.accountNumber,
            accountName: resolved.account.accountName,
            subAccountCode: created.account.subAccountCode,
          };
          resolvedName = resolved.account.accountName;

          extra.push(
            para(
              `🏦 That account is ${b(resolved.account.accountName)} at ${bank.name}.`,
              lines(
                `Move your payouts there?`,
                `It takes effect in ${b("24 hours")} — until then, money goes to your current account.`,
              ),
            ),
          );
          buttons = VOICE.yesNo("✅ Move it", "❌ Keep current");
          break;
        }

        case "commit_bank_change": {
          const change = ctx.changing;
          if (!change) {
            extra.push(`⌛ That change has expired. Reply ${b("change bank")} to start again.`);
            break;
          }

          const effectiveAt = await scheduleBankChange(userId, change, log);
          extra.push(bankChangeScheduled(change, effectiveAt));

          // F17 step 3. Not awaited on the reply path, and it cannot fail the
          // change: the alert is a warning, not a gate.
          void raiseSecurityAlert(
            {
              userId,
              what: "your payout bank was changed",
              detail: [
                `New account: ${change.accountName} at ${change.bankName}, ending ${change.accountNumber.slice(-4)}.`,
                `It takes effect in ${CHANGE_DELAY_HOURS} hours. Until then payments settle to your current account.`,
              ],
              undoHint: "reply STOP on WhatsApp or email hello@balans.ng now, and we will cancel it.",
            },
            log,
          );
          break;
        }

        case "cancel_bank_change":
          await cancelPendingChange(userId);
          break;

        case "delete_account": {
          // F17: cancel open invoices, disconnect payouts, keep the ledger.
          // Anonymising personal data waits for the retention period, so this
          // marks the account closed and hands it to a person rather than
          // deleting rows an auditor may need.
          await tx(async (c) => {
            await c.query(
              `UPDATE documents SET status = 'cancelled', cancelled_at = now()
                WHERE user_id = $1 AND status IN ('draft', 'sent', 'viewed', 'overdue')
                  AND amount_paid_kobo = 0`,
              [userId],
            );
            await c.query(`UPDATE bank_accounts SET status = 'retired' WHERE user_id = $1`, [userId]);
            await c.query(`UPDATE reminders SET status = 'cancelled'
                            WHERE status = 'pending'
                              AND document_id IN (SELECT id FROM documents WHERE user_id = $1)`, [userId]);
            await c.query(`UPDATE users SET status = 'closed', deleted_at = now() WHERE id = $1`, [userId]);
            await c.query(
              `INSERT INTO risk_flags (user_id, kind, detail, status)
               VALUES ($1, 'account_deletion', 'user asked to close their account', 'open')`,
              [userId],
            );
          });
          log.warn({ userId }, "account closed at the user's request");
          extra.push(deletionStarted());
          break;
        }
        case "show_upgrade": {
          const state = await stateOf(userId);
          if (state.plan === "pro") {
            extra.push(proActive(state));
            break;
          }
          const used = await documentsThisMonth(userId, ctx.today);
          extra.push(proOffer(used));
          buttons = proOfferButtons();
          break;
        }

        case "start_pro": {
          if (effect.method === "deduct_from_invoice") {
            await openSubscription(userId, "deduct_from_invoice", log);
            extra.push(deductChosen());
            break;
          }

          // A payment link is just an invoice we are the client of: the same
          // Monnify initialisation, with no split, because this one is ours.
          const opened = await openSubscription(userId, "link", log);
          const reference = `sub_${opened.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;
          const { rows } = await db().query<{ email: string | null }>(
            `SELECT email FROM users WHERE id = $1`, [userId]);

          const init = await initTransaction({
            amountKobo: opened.priceKobo,
            customerName: businessName ?? "Balans user",
            customerEmail: rows[0]?.email ?? `${userId}@users.balans.ng`,
            paymentReference: reference,
            description: "Balans Pro, one month",
            redirectUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/callback?ref=${reference}`,
            // No split: this payment is ours, not the user's.
          });

          if (!init.ok) {
            log.error({ userId, message: init.message }, "could not create a Pro payment link");
            extra.push("⏳ I could not reach the payment provider. Try again in a moment.");
            break;
          }

          // Without this the webhook has nothing to match the payment to, and
          // a paid subscription stays pending forever.
          await attachPaymentReference(opened.id, reference);
          await db().query(
            `UPDATE subscriptions SET status = 'pending' WHERE id = $1`, [opened.id]);

          extra.push(payLinkMessage(init.checkoutUrl));
          break;
        }
        case "show_referral":
          extra.push(VOICE.notBuiltYet("Referrals"));
          break;
        case "document_action": {
          const number = effect.number;

          if (effect.intent === "stop_reminders") {
            const stopped = await stopReminders(userId, number);
            extra.push(remindersStoppedMessage(stopped, number));
            break;
          }

          if (effect.intent === "cancel_document") {
            if (!number) { extra.push(notFoundMessage({})); break; }
            const done = await cancelDocument(userId, number);
            extra.push(done.ok ? cancelledMessage(done.value) : cannotCancelMessage(number, done.why));
            break;
          }

          if (effect.intent === "resend_document") {
            if (!number) { extra.push(notFoundMessage({})); break; }
            const found = await findForResend(userId, number);
            if (!found.ok) { extra.push(notFoundMessage({ number })); break; }

            const d = found.value;
            const link = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${d.publicToken}`;
            const caption = resendMessage(d, link);

            // F6: "returns the current PDF and link." The stored one, not a new
            // render — the client must get the document they already have.
            const pdf = await renderDocumentPdf(d.id, log);
            if (pdf && ctx.phone) {
              const up = await uploadDocument(pdf.bytes, pdf.filename);
              if (up.ok) {
                const sent = await sendDocument(ctx.phone, up.mediaId, pdf.filename, caption);
                if (sent.ok) {
                  await recordOutbound(userId, sent.waMessageId, "sent", { kind: "document" });
                  break;
                }
              }
            }
            extra.push(caption);
            break;
          }

          if (effect.intent === "convert_quote") {
            if (!number) { extra.push(notFoundMessage({})); break; }
            const due = addDaysTo(ctx.today, defaults.behaviour.defaultDueDays);
            const done = await convertQuote(userId, number, due);
            extra.push(done.ok ? convertedMessage(done.value) : cannotConvertMessage(number, done.why));
            break;
          }

          // Status is the remaining one that works; the rest still say so.
          if (effect.intent !== "status") {
            extra.push(VOICE.notBuiltYet(ACTION_NAMES[effect.intent] ?? "That"));
            break;
          }

          const by = { number, clientName: ctx.parsed?.clientName ?? null };
          if (!by.number && !by.clientName) {
            extra.push(notFoundMessage(by));
            break;
          }

          const found = await findDocument(userId, by);
          extra.push(
            found
              ? statusMessage(found, ctx.today, env.PUBLIC_BASE_URL)
              : notFoundMessage(by),
          );
          break;
        }
      }
    } catch (err) {
      log.error({ err, userId, effect: effect.type }, "effect failed");
      extra.push(
        para(
          `⚠️ ${b("Something went wrong on our side.")}`,
          lines(
            "Nothing was changed. Try again in a moment.",
            `If it keeps happening, email ${b("hello@balans.ng")}.`,
          ),
        ),
      );
      failed = true;
      break;
    }
  }

  if (businessName) {
    // Worth persisting the moment we have it: if someone drops out halfway,
    // we still know who they are.
    await setBusinessName(userId, businessName).catch((e: unknown) =>
      log.error({ err: e, userId }, "could not save business name"),
    );
  }

  return { lines: extra, holdAt, failed, resolvedName, draftId, clearDraft, pendingBankChange, buttons };
}


/**
 * Someone sent a picture.
 *
 * On Pro it becomes their logo and appears on every invoice from the next one
 * onwards. On Free it is refused with the reason, because silently ignoring a
 * file somebody deliberately sent reads as the product being broken — and
 * because this is the one moment they are actively wanting something Pro gives
 * them.
 */
/**
 * A completed onboarding form.
 *
 * Four answers land together, so the six questions collapse into one exchange.
 * What cannot collapse is the bank check: ten digits and a bank name are not
 * proof of an account, and somebody who mistypes a digit would otherwise be
 * paid into a stranger's account forever. So this writes what it can trust,
 * resolves the account, and asks the one question that has to be asked.
 *
 * Every value is treated as if a person typed it, because a person did.
 */
async function handleOnboardingForm(
  userId: string,
  phone: string,
  fields: Record<string, string>,
  log: FastifyBaseLogger,
): Promise<void> {
  const businessName = (fields.business_name ?? "").trim();
  const email = (fields.email ?? "").trim().toLowerCase();
  const accountNumber = (fields.account_number ?? "").replace(/\D/g, "");

  // "Other" means the dropdown did not have their bank, so the free-text box
  // beside it is the real answer.
  const chosen = (fields.bank ?? "").trim();
  const bankQuery = chosen === OTHER_BANK ? (fields.other_bank ?? "").trim() : chosen;

  log.info({ userId, hasName: Boolean(businessName), hasEmail: Boolean(email) }, "onboarding form received");

  if (!businessName || !email || !bankQuery || accountNumber.length !== 10) {
    // The form marks these required, so getting here means something odd.
    // Falling back to the questions is better than guessing at a blank.
    await saveConversation(userId, "onboarding:business_name", {});
    await reply(userId, phone, [VOICE.setupByHand], log);
    return;
  }

  await setBusinessName(userId, businessName);

  const banks = await listBanks();
  const bank = matchBank(bankQuery, banks);
  if (!bank) {
    await saveConversation(userId, "onboarding:bank", { email });
    await reply(
      userId,
      phone,
      [para(`🤔 I could not find ${b(bankQuery)}.`, VOICE.askBank)],
      log,
    );
    return;
  }

  const resolved = await resolveAccount(accountNumber, bank.code);
  if (!resolved.ok) {
    await saveConversation(userId, "onboarding:bank", { email });
    await reply(
      userId,
      phone,
      [
        para(
          resolved.reason === "invalid_details"
            ? `🤔 ${b("That account did not check out.")}`
            : `⏳ ${b("The bank did not answer just now.")}`,
          VOICE.askBank,
        ),
      ],
      log,
    );
    return;
  }

  await saveBankAccount(userId, {
    bankCode: bank.code,
    bankName: bank.name,
    accountNumber,
    accountName: resolved.account.accountName,
  });

  await saveConversation(userId, "onboarding:confirm_account", {
    email,
    resolvedAccountName: resolved.account.accountName,
  });

  await reply(
    userId,
    phone,
    [
      para(
        `🏦 That account is ${b(resolved.account.accountName)} at ${bank.name}.`,
        "Is that you?",
      ),
    ],
    log,
    VOICE.yesNo("✅ That's me", "❌ Not me"),
  );
}

/**
 * A completed business-details form.
 *
 * Nothing here needs verifying: a name, an address and a tax number are what
 * the user says they are, and they print on an invoice rather than deciding
 * where money goes. The email is the exception — changing it changes where
 * receipts land — so it goes through the same code the settings flow uses
 * rather than being written straight in.
 */
async function handleDetailsForm(
  userId: string,
  phone: string,
  fields: Record<string, string>,
  log: FastifyBaseLogger,
): Promise<void> {
  const businessName = (fields.business_name ?? "").trim();
  const address = (fields.address ?? "").trim();
  const tin = (fields.tin ?? "").trim();
  const email = (fields.email ?? "").trim().toLowerCase();

  if (!businessName) {
    await reply(userId, phone, ["🤔 A business name cannot be empty. Nothing was changed."], log);
    return;
  }

  await setBusinessName(userId, businessName);
  await db().query(
    `UPDATE users SET address = NULLIF($2, ''), tin = NULLIF($3, '') WHERE id = $1`,
    [userId, address, tin],
  );

  const { rows } = await db().query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1`,
    [userId],
  );
  const changedEmail = email && email !== (rows[0]?.email ?? "");

  log.info({ userId, changedEmail }, "business details updated");

  const said = [
    para(
      `✅ ${b("Saved.")}`,
      lines(
        row("Business", businessName),
        address ? row("Address", address) : false,
        tin ? row("TIN", tin) : false,
      ),
    ),
  ];

  if (changedEmail) {
    // A new address is not a verified address, and receipts must not start
    // going somewhere nobody has proved they can read.
    await saveConversation(userId, "onboarding:verify_email", { email });
    await setEmail(userId, email);
    const issued = await issueCode(userId, "email_verify", email);
    said.push(
      issued.ok
        ? VOICE.askCode(email)
        : "⏳ I could not send the code just now. Try again in a minute.",
    );
    await reply(userId, phone, said, log, issued.ok ? VOICE.codeButtons() : undefined);
    return;
  }

  await reply(userId, phone, said, log);
}

/**
 * A submitted invoice form becomes an ordinary draft.
 *
 * Everything after this point is the path a typed sentence takes: the same
 * plan limits, the same summary, the same "Send it?" with the same three
 * buttons. The form replaces the reading of the message, and nothing else —
 * F6 still stands, and nothing leaves without the user confirming it.
 *
 * The fields are checked here rather than trusted. A Flow's own validation
 * runs on the client, and what comes back has travelled through it.
 */
async function handleInvoiceForm(
  userId: string,
  phone: string,
  fields: Record<string, string>,
  businessName: string | undefined,
  log: FastifyBaseLogger,
  today: Civil,
): Promise<void> {
  const clientName = (fields.client_name ?? "").trim();
  const description = (fields.description ?? "").trim();
  const email = (fields.client_email ?? "").trim().toLowerCase();
  const notes = (fields.notes ?? "").trim();
  const duePhrase = (fields.due_date ?? "").trim();

  const totalKobo = parseAmountToKobo((fields.amount ?? "").trim());

  // Required in the form, so an empty one means the form was not the thing
  // that sent this. Saying which field rather than "something went wrong"
  // leaves them somewhere they can act.
  if (!clientName || !description || totalKobo === null || totalKobo <= 0) {
    log.warn({ userId, hasClient: Boolean(clientName), totalKobo }, "invoice form was incomplete");
    await reply(
      userId,
      phone,
      [
        para(
          `🤔 ${b("That form came back missing something.")}`,
          "A client, what the work is, and an amount. Try again, or just tell me in a sentence.",
        ),
      ],
      log,
    );
    return;
  }

  // The date is words, on purpose, and the same reader handles it here as in
  // a sentence. A phrase we cannot read is not worth refusing the whole
  // invoice over — the draft goes out without a due date and the user can say
  // "due Friday" to the summary, which already works.
  const resolved = duePhrase ? resolveDueDate(duePhrase, today) : null;
  if (duePhrase && !resolved) {
    log.info({ userId, duePhrase }, "unreadable due date from the invoice form");
  }

  const { depositPercent, instalments } = splitForPlan(fields.plan);

  const doc: PendingDoc = {
    type: "invoice",
    clientName,
    clientEmail: email || null,
    lines: [{ description, qty: 1, unitAmountKobo: totalKobo }],
    dueDate: resolved?.date ?? null,
    // An OptIn comes back as the string "true", not a boolean.
    vatPercent: fields.vat === "true" ? VAT_PERCENT : null,
    depositPercent,
    instalments,
    passFeesToClient: fields.pass_fees === "true",
    notes: notes || null,
  };

  const outcome = await runEffects([{ type: "save_draft", doc }], userId, businessName, log, {
    today,
    phone,
  });

  const context: Record<string, unknown> = { doc };
  if (outcome.draftId) context.draftId = outcome.draftId;

  // An effect that held — the monthly limit — never wrote a draft, and there
  // is nothing for a "yes" to refer to.
  await saveConversation(
    userId,
    outcome.holdAt ?? (outcome.draftId ? "awaiting_confirm" : "idle"),
    outcome.draftId ? context : {},
  );
  await reply(userId, phone, outcome.lines, log, outcome.buttons);

  log.info({ userId, draftId: outcome.draftId, depositPercent, instalments }, "draft from a form");
}

async function handleLogo(
  userId: string,
  mediaId: string,
  phone: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const plan = await planOf(userId);

  if (plan !== "pro") {
    await reply(
      userId,
      phone,
      [
        para(
          `🎨 ${b("Your own logo is a Pro feature.")}`,
          lines(
            "On Pro it replaces the Balans line on every invoice you send.",
            `Reply ${b("upgrade")} to turn it on, and send the image again.`,
          ),
        ),
      ],
      log,
    );
    return;
  }

  const saved = await saveLogo(userId, mediaId, log);

  const said =
    saved.ok
      ? para(
          `✅ ${b("Logo saved.")}`,
          lines(
            "It goes on every invoice and quote you send from now on.",
            `Send another image any time to replace it, or reply ${b("remove logo")} to take it off.`,
          ),
        )
      : saved.why === "too_large"
        ? lines(`📏 ${b("That image is too big.")}`, "Send one under 2MB and I will use it.")
        : saved.why === "not_an_image"
          ? lines(
              `🖼️ ${b("I could not read that as an image.")}`,
              "A PNG or JPG works best.",
            )
          : lines(
              `⚠️ ${b("I could not fetch that image.")}`,
              "Try sending it again in a moment.",
            );

  await reply(userId, phone, [said], log);
}

/** Seven days from a civil date, without pulling in the date module's clock. */
function addDaysTo(c: { y: number; m: number; d: number }, days: number) {
  const at = new Date(Date.UTC(c.y, c.m - 1, c.d) + days * 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/**
 * A command, in the shape the machine expects a parse to be.
 *
 * Only the fields a command can carry are filled in; everything else is the
 * empty answer, because a command says what to do and nothing about a
 * document.
 */
function commandAsParsed(c: { intent: Parsed["intent"]; documentNumber?: number }): Parsed {
  return {
    intent: c.intent,
    clientName: null,
    clientEmail: null,
    lineItems: [],
    totalKobo: null,
    dueDate: null,
    dueDatePhrase: null,
    documentNumber: c.documentNumber ?? null,
    options: {
      depositPercent: null,
      instalments: null,
      passFeesToClient: null,
      vatPercent: null,
      notes: null,
    },
    confidence: 1,
    source: "command",
    missing: [],
  };
}

/** Named so the "not built yet" line reads like the thing they asked for. */
const ACTION_NAMES: Record<string, string> = {
  status: "Invoice status",
  cancel_document: "Cancelling",
  resend_document: "Resending",
  convert_quote: "Converting a quote",
  edit_document: "Editing a sent document",
  payment_request: "Quick payment requests",
  record_payment: "Recording an offline payment",
  stop_reminders: "Reminders",
};

/**
 * How many times payout setup has failed for this user.
 *
 * Counted from `risk_flags` rather than the conversation context, because the
 * conversation is reset by "cancel" and this must not be. Somebody who has hit
 * the same wall three times has hit it three times, whatever they typed in
 * between.
 */
async function countSetupFailures(userId: string): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM risk_flags
      WHERE user_id = $1 AND kind = 'setup_failed' AND created_at > now() - interval '7 days'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** Records the failure, and on the third one asks a human to step in (F1). */
async function flagSetupForReview(
  userId: string,
  why: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await db().query(
      `INSERT INTO risk_flags (user_id, kind, detail, status)
       VALUES ($1, 'setup_failed', $2, 'open')`,
      [userId, why.slice(0, 500)],
    );
    log.error({ userId, why }, "payout setup flagged for admin review");
  } catch (err) {
    log.error({ err, userId }, "could not flag payout setup for review");
  }
}

/**
 * What the business-details form opens filled in with.
 *
 * Every value is a string because Flow JSON has no null: a field with nothing
 * in it is an empty one, not a missing one.
 */
async function detailsFor(userId: string): Promise<Record<string, string>> {
  const { rows } = await db().query<{
    business_name: string | null;
    email: string | null;
    address: string | null;
    tin: string | null;
  }>(`SELECT business_name, email, address, tin FROM users WHERE id = $1`, [userId]);

  const u = rows[0];
  return {
    business_name: u?.business_name ?? "",
    email: u?.email ?? "",
    address: u?.address ?? "",
    tin: u?.tin ?? "",
  };
}

/** Reported at boot so nobody wonders why no email arrived. */
export function emailTransport(): string {
  return transport();
}

const PAUSE_BETWEEN_LINES_MS = 700;

async function reply(
  userId: string,
  to: string,
  lines: string[],
  log: FastifyBaseLogger,
  /**
   * Tappable answers. They go on the last line, because that is the one
   * carrying the question — the lines before it are context.
   */
  buttons?: ReplyButton[],
): Promise<void> {
  const send = lines.filter((l) => l.trim());

  for (const [i, body] of send.entries()) {
    // A beat between lines. Two messages landing in the same instant read as a
    // dump; a short gap reads as someone typing the second one.
    //
    // The typing bubble is not re-sent here: it hangs off a read receipt for a
    // specific inbound message, and re-marking one already read is not what
    // that call is for. It is shown once when the message arrives, which is
    // when there is actually something to wait for.
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_LINES_MS));

    // An interactive message costs the same as a text one, so this replaces
    // the last line rather than following it.
    const last = i === send.length - 1;
    const withButtons = last && buttons && buttons.length > 0 && buttons.length <= 3;

    const res = withButtons
      ? await sendButtons(to, { body, buttons })
      : await sendText(to, body);
    if (res.ok) {
      await recordOutbound(userId, res.waMessageId, "sent", withButtons ? { kind: "interactive" } : undefined);
    } else {
      // Outside the 24-hour window is a product condition, not an outage: it
      // needs an approved template, and retrying free text cannot help.
      log.error(
        { userId, reason: res.reason, code: res.code, outsideWindow: res.outsideWindow },
        res.outsideWindow ? "cannot reply outside the service window" : "send failed",
      );
      await recordOutbound(userId, null, res.outsideWindow ? "outside_window" : "failed", {
        inWindow: !res.outsideWindow,
      });
      break; // No point sending line two if line one did not land.
    }
  }
}
