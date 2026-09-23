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
import {
  step,
  VOICE,
  LIMIT_CARD,
  UPGRADE_CARD,
  SETUP_DONE_CARD,
  type Effect,
  type PendingDoc,
  type State,
} from "./machine.ts";
import { splitForPlan } from "../whatsapp/flows/definitions.ts";
import { VAT_PERCENT } from "../parser/extract.ts";
import { forLog, type Parsed } from "../parser/schema.ts";
import { b, i, lines, para, row } from "../whatsapp/format.ts";
import { parseMessage } from "../parser/parse.ts";
import { readCorrection } from "../parser/corrections.ts";
import { asCommand } from "../parser/commands.ts";
import { resolveDueDate, todayIn, type Civil } from "../../core/dates.ts";
import { defaults, env } from "../config.ts";
import { confirmDraft, createDraft, discardDraft, getOpenDraft } from "../documents/store.ts";
import {
  draftButtons,
  draftSummary,
  sentMessage,
  convertedForward,
} from "../documents/summary.ts";
import { partsFor } from "../documents/parts.ts";
import { linesFromForm } from "../documents/form-lines.ts";
import { formatNaira } from "../../core/totals.ts";
import { proStartUrl } from "../billing/pro-link.ts";
import { pickerUrlFor } from "../http/routes/templates.ts";
import { clearLogo, saveLogo } from "../brand/user-logo.ts";
import {
  debtors,
  documentsEverSent,
  documentsThisMonth,
  findDocument,
  planOf,
  summarise,
} from "../documents/queries.ts";
import {
  cancelledMessage,
  cannotCancelMessage,
  cannotConvertMessage,
  convertedMessage,
  debtorsMessage,
  limitReachedMessage,
  limitReachedCaption,
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
import {
  deductChosen,
  payLinkCaption,
  payLinkMessage,
  proActive,
  proOffer,
  proOfferButtons,
} from "../billing/messages.ts";
import { settingsMenu, settingsList, bankChangeScheduled, deletionStarted } from "../settings/messages.ts";
import { sendCta, sendFlow, sendList } from "../whatsapp/client.ts";
import { helpButtons } from "./menu.ts";
import { TEMPLATES } from "../pdf/templates.ts";
import { flowId } from "../whatsapp/flows/register.ts";

/**
 * What counts as STOP when a payout change is waiting.
 *
 * Deliberately close to the bare word. "stop reminders" is a different and
 * far less urgent request, and reading it as this one would quietly leave
 * somebody's reminders on while telling them their bank change was cancelled.
 */
const STOPS_A_CHANGE = /^(stop|stop it|cancel|cancel it|stop the change|cancel the change)[.!]?$/i;

/**
 * How many sent documents still carry the "pick a design" offer.
 *
 * Two, because the first invoice is a busy moment and the offer is easy to
 * miss. Not more, because every one of them is a chargeable message asking
 * again about something the user has already not acted on.
 */
const DESIGN_OFFER_LIMIT = 2;

/**
 * The menu, tappable, with the typed one as its fallback.
 *
 * Both callers go through here. The first version of this lived only inside
 * the `show_help` effect, which meant a greeting and an opened chat — the two
 * moments somebody is most likely to be seeing this product for the first
 * time — still got a wall of slash commands nobody can tap.
 */
async function sendMenu(
  userId: string,
  phone: string | undefined,
  fallback: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (!phone) return fallback;

  const sent = await sendButtons(phone, {
    headerImage: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/brand/cheatsheet.png`,
    body: VOICE.helpCaption,
    buttons: helpButtons(),
  });

  if (sent.ok) {
    await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
    return null;
  }

  log.warn({ userId, reason: sent.reason }, "cheat sheet failed, sending the menu as words");
  return fallback;
}

/**
 * Whether this person can start another document, and the card if they cannot.
 *
 * Asked before the form opens, not after it comes back. It used to be asked
 * only in `save_draft`, which is the moment a filled-in form arrives — so the
 * answer was "you have run out" delivered to somebody who had just typed a
 * client, an amount and a description into four fields. The work was thrown
 * away and the refusal read as a bug.
 *
 * Returns null when there is room. Returns the words-only message when there
 * is not and the card could not be sent, so the caller can push it as text.
 */
async function limitCard(
  userId: string,
  phone: string | undefined,
  today: Civil,
  log: FastifyBaseLogger,
): Promise<{ stop: false; plan: "free" | "pro" } | { stop: true; words: string | null }> {
  // Independent of each other, and both are needed. One round trip, not two.
  const [plan, used] = await Promise.all([planOf(userId), documentsThisMonth(userId, today)]);
  const limit = defaults.plans[plan].documentsPerMonth;

  // Handed back rather than thrown away: the draft summary has to say what
  // the user will be paid, and that is the plan's fee. Asking again would be
  // a second query for something already in hand — and a second query is a
  // second answer, which is how a summary ends up disagreeing with the gate
  // that let it through.
  if (limit === null || used < limit) return { stop: false, plan };

  log.info({ userId, used, limit, plan }, "monthly document limit reached");
  const words = limitReachedMessage(used, limit, today);
  if (!phone) return { stop: true, words };

  const sent = await sendButtons(phone, {
    headerImage: LIMIT_CARD,
    body: limitReachedCaption(used, limit, today),
    // The id is the word the parser already reads, so tapping this and typing
    // "upgrade" are the same message arriving by different routes.
    buttons: [{ id: "upgrade", title: "Upgrade to Pro" }],
  });

  if (sent.ok) {
    await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
    return { stop: true, words: null };
  }

  log.warn({ userId, reason: sent.reason }, "limit card failed, sending the limit as words");
  return { stop: true, words };
}

/**
 * The terms, as a form rather than two links.
 *
 * Nobody opens a legal page on their phone in the middle of signing up, so
 * the links version meant people agreeing to something they had not read —
 * the situation consent exists to avoid. The form says the five things that
 * actually affect somebody and keeps the full documents one tap away.
 *
 * Returns false when there is no form to send, and the caller falls back to
 * the message and the button. That path is not theoretical: Meta will not
 * publish a Flow until the business is verified, and nobody should be unable
 * to finish signing up because of it.
 */
async function sendConsentForm(
  userId: string,
  phone: string | undefined,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const id = await flowId("consent");
  if (!id || !phone) return false;

  const sent = await sendFlow(phone, {
    body: VOICE.consentFormBody,
    cta: "Read and agree",
    flowId: id,
    token: `consent:${userId}`,
    screen: FLOW_SCREEN.consent,
    draft: env.WA_FLOWS_DRAFT === "true",
  });

  if (!sent.ok) {
    log.warn({ userId, reason: sent.reason }, "consent form failed, asking in words");
    return false;
  }

  await recordOutbound(userId, sent.waMessageId, "sent", { kind: "interactive" });
  return true;
}

/** The screen each Flow opens on. */
const FLOW_SCREEN = {
  onboarding: "BUSINESS",
  business_details: "DETAILS",
  invoice: "WORK",
  quote: "WORK",
  consent: "TERMS",
  request: "WORK",
} as const;
import { OTHER_BANK } from "../whatsapp/flows/banks.ts";
import { sendDocument, uploadDocument } from "../whatsapp/client.ts";
import {
  loadConversation,
  recordInbound,
  hasChosenTemplate,
  recordOutbound,
  reopenAccount,
  saveConversation,
  setBusinessName,
  upsertUser,
  type Conversation,
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
  const [first, loaded] = await Promise.all([
    // Meta redelivers on any doubt. Storing the id first means a repeat stops
    // here rather than producing a second reply to the same sentence.
    recordInbound(user.id, msg.waMessageId, msg.kind),
    loadConversation(user.id),
  ]);

  if (!first) {
    log.info({ waMessageId: msg.waMessageId }, "duplicate delivery ignored");
    return;
  }

  /*
   * Somebody is writing to us after closing their account.
   *
   * This used to return here and the number simply went dead: every message
   * after the closing one was read, logged and dropped, with nothing sent
   * back and no way to find out why. Closing is a thing people do and then
   * reconsider — that is the ordinary reason to write to us again — so the
   * message reopens the account and setup starts from the first question.
   *
   * Nothing of the old arrangement returns with it. `reopenAccount` says what
   * survives and what does not.
   */
  const reopened = user.status === "closed";
  if (reopened) {
    await reopenAccount(user.id);
    log.warn({ userId: user.id }, "closed account reopened by a message");
  }

  // The conversation was read before the reopening wiped it, and its context
  // describes an account that no longer exists.
  const saved: Conversation = reopened ? { state: "new", context: {} } : loaded;

  // Blue ticks and the typing bubble, before the thinking starts. Not awaited:
  // it is decoration, and the reply must not wait on a read receipt.
  void markRead(msg.waMessageId, { typing: true, to: msg.from });

  // Said before setup begins, so the fresh questions are not a surprise to
  // somebody who expects us to remember them.
  if (reopened) await reply(user.id, msg.from, [VOICE.welcomeBack], log);

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
    if (state === "new") {
      await reply(user.id, msg.from, [VOICE.askBusinessName], log);
      return;
    }
    const words = await sendMenu(user.id, msg.from, VOICE.helpIdle, log);
    if (words) await reply(user.id, msg.from, [words], log);
    return;
  }

  /*
   * An image might be a logo (F21), so we ask.
   *
   * It used to be saved as one on sight, on the reasoning that the only
   * sensible thing to send an invoicing bot is a logo. That is not what
   * happens. People send screenshots — a bank alert, a chat with a client,
   * an invoice that looks wrong — and every one of them silently replaced
   * the logo on all their future invoices, with a confirmation message that
   * is easy to scroll past.
   *
   * One question costs one message and removes the whole class of it. The
   * picture is not downloaded until the answer, so a screenshot costs
   * nothing but the question.
   *
   * Still handled before the machine, because a picture arrives unannounced
   * and must not disturb a draft somebody is halfway through confirming.
   */
  if (msg.kind === "image" && msg.mediaId) {
    await saveConversation(user.id, "awaiting_logo_confirm", {
      ...saved.context,
      pendingLogo: msg.mediaId,
    });
    await reply(user.id, msg.from, [VOICE.isThisYourLogo], log, VOICE.logoButtons());
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
    if (key === "consent") {
      await handleConsentForm(user.id, msg.from, msg.flow.fields, log);
      return;
    }
    if (key === "business_details") {
      await handleDetailsForm(user.id, msg.from, msg.flow.fields, log);
      return;
    }
    if (key === "invoice" || key === "quote" || key === "request") {
      await handleInvoiceForm(
        key === "request" ? "payment_request" : key,
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

  /*
   * STOP, while a bank change is waiting to take effect.
   *
   * This is the one message in the product that has to work. The security
   * notice says "reply STOP on WhatsApp and we will cancel it", and the
   * twenty-four hour delay exists so that somebody whose WhatsApp has been
   * taken over has a window to use it.
   *
   * It did not work. "stop" reads as a rejection — it is on the same list as
   * "no" and "cancel" — so at idle it answered "there is no draft waiting"
   * and the change went ahead. The cancel branch existed, but only on the
   * confirmation question, which is before the change is scheduled and not
   * the moment anybody needs it.
   *
   * Handled here rather than in the machine because the machine is pure and
   * cannot ask whether a change is pending. It runs before everything: a
   * scheduled payout change is the only thing on this number where being a
   * few seconds late matters, and nothing else it might have meant is worth
   * more than getting it wrong.
   *
   * Narrow on purpose. Only a message that is essentially the word itself —
   * not "stop reminders", which is a different and much less urgent thing.
   */
  if (STOPS_A_CHANGE.test(text.trim()) && (await cancelPendingChange(user.id))) {
    log.warn({ userId: user.id }, "scheduled bank change cancelled by STOP");
    await reply(
      user.id,
      msg.from,
      [
        para(
          `\u{1F6D1} ${b("Stopped.")}`,
          lines(
            "Your payout account has not changed and nothing is scheduled.",
            "Money keeps going where it was going.",
          ),
          i("If you did not ask for that change, email hello@balans.ng now."),
        ),
      ],
      log,
    );
    return;
  }

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
      // A tap is unambiguous in a way typing is not, and the machine cannot
      // tell from the text alone: a row id arrives as ordinary words.
      tapped: msg.kind === "interactive",
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

  /*
   * The picture goes with the effect's buttons, and only with those.
   *
   * A card is the header of one specific message. If the effect did not add
   * the buttons — because it held, or faulted, and the machine's question is
   * the one being asked — then the message the card belongs above was never
   * sent, and putting it over an unrelated question is worse than dropping it.
   */
  const buttonsImage = outcome.buttons ? outcome.buttonsImage : undefined;

  await saveConversation(user.id, next, context);
  await reply(user.id, msg.from, replies, log, buttons, buttonsImage);

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
  /**
   * A picture above the button message.
   *
   * Only meaningful with `buttons`, because reply buttons are the one
   * interactive type Meta accepts an image header on — a list is rejected
   * outright. See `sendButtons`.
   */
  buttonsImage?: string;
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
  // "Is this your logo?" takes yes or no for free, through asCommand. Anything
  // else is read as an ordinary message and has to be understood, or somebody
  // who sends a screenshot and then types an invoice loses the invoice.
  "awaiting_logo_confirm",
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
  let buttonsImage: string | undefined;
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
        case "show_help": {
          /*
           * The menu, tappable.
           *
           * Nine rows and nine commands, and each row's id is the command it
           * stands for — so a tap and a typed "/invoice" are the same message
           * by the time anything reads them.
           *
           * The typed menu is still the answer whenever the list cannot go:
           * no phone on the context, or Meta refusing it. Somebody asking what
           * this thing does must never be met with nothing.
           */
          const words = await sendMenu(userId, ctx.phone, effect.fallback, log);
          if (words) extra.push(words);
          break;
        }

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

          // Asking for the email here is how the conversation collects it in
          // one turn instead of two. But when the setup form already has it —
          // which is every time the form was filled and only the bank failed —
          // asking again reads as though nothing they typed was kept.
          extra.push(
            para(
              `🏦 That account is ${b(resolved.account.accountName)} at ${bank.name}.`,
              effect.haveEmail
                ? "Is that you?"
                : lines(
                    `If that is right, ${b("send your email address")} — receipts and invoice copies go there.`,
                    `If it is not, reply ${b("no")}.`,
                  ),
            ),
          );
          if (effect.haveEmail) buttons = VOICE.yesNo("✅ That's me", "❌ Not me");
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
          /*
           * The plan limit, asked before the form opens.
           *
           * Only for the three document forms. Onboarding and business details
           * are not documents and have no limit to hit — checking them would
           * lock somebody out of finishing their own setup.
           *
           * Before the `flowId` lookup as well, so the words-only fallback
           * below does not invite a document that cannot be created either.
           */
          if (effect.key === "invoice" || effect.key === "quote" || effect.key === "request") {
            const gate = await limitCard(userId, ctx.phone, ctx.today, log);
            if (gate.stop) {
              if (gate.words) extra.push(gate.words);
              holdAt = "idle";
              break;
            }
          }

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
            headerImage: effect.image,
            flowId: id,
            // Ties the submission back to this person. Read on the way in, and
            // never trusted for anything the sender could have chosen.
            token: `${effect.key}:${userId}`,
            screen: FLOW_SCREEN[effect.key],
            // The invoice form carries its starting values on the effect;
            // business details are read here because only this side has a
            // database.
            data:
              effect.data ??
              (effect.key === "business_details" ? await detailsFor(userId) : undefined),
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
            /*
             * The terms, in a form rather than as two links.
             *
             * Nobody opens a legal page on their phone in the middle of
             * signing up, so the links version meant people agreeing to
             * something they had not seen \u2014 the situation consent exists to
             * avoid. The form says the five things that actually affect them
             * and keeps the documents one tap away.
             *
             * The fallback is the old message and button, which still has to
             * work: until the business is verified Meta will not publish a
             * Flow, and somebody cannot be left unable to finish signing up
             * because of that.
             */
            if (!(await sendConsentForm(userId, ctx.phone, log))) {
              extra.push(VOICE.confirmedAskConsent);
              buttons = VOICE.consentButtons();
            }
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

          /*
           * F6: plan limits, checked again.
           *
           * The form path is already stopped before it opens, but a typed
           * invoice never passes through `send_flow` and arrives straight
           * here. This is also the last point at which refusing costs the
           * user nothing: drafting something and refusing to send it
           * afterwards would be worse, because by then they have read and
           * approved it.
           */
          const gate = await limitCard(userId, ctx.phone, ctx.today, log);
          if (gate.stop) {
            if (gate.words) extra.push(gate.words);
            holdAt = "idle";
            break;
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
          }, ctx.today);
          draftId = draft.id;
          extra.push(draftSummary(draft, ctx.today, gate.plan));
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

          /*
           * A payment request has no PDF, and that is the whole of what it is.
           *
           * F8 calls it "a lightweight payable with no PDF". The payment page
           * has always honoured that — it deliberately offers no download for
           * one, because "there is nothing itemised to render, and offering
           * one implies there is". The send path did not, so WhatsApp attached
           * a document the page then refused to hand over, and the file itself
           * was a one-line page carrying a number and a link, which is the
           * paperwork a request exists to skip.
           *
           * So an invoice and a quote arrive as a document to forward, and a
           * request arrives as a message with a link in it. That difference is
           * the reason to have three of them.
           */
          const pdf =
            confirmed.type === "payment_request"
              ? null
              : await renderDocumentPdf(confirmed.id, log);

          /*
           * The design picker, once or twice and then never again.
           *
           * It used to ride on the note as a button, which was free because the
           * note was a message anyway. The note is now in the caption, so this
           * is the only thing that would cost an extra send.
           *
           * "Somebody who has never chosen a design" was the whole gate, and
           * that is not once in the life of an account — it is every invoice
           * they ever send, for anyone who sees the offer and is not
           * interested. From October that is ₦14.50 each time to re-ask a
           * question they have already declined, which on twenty invoices a
           * month is ₦290 of being nagged.
           *
           * So: the first two, and then it stops. Two rather than one because
           * the first invoice is a busy moment and the offer is easy to miss.
           * After that `/design` is the way in, and it is on the menu.
           */
          const offerDesigns = async (): Promise<void> => {
            if (!ctx.phone || (await hasChosenTemplate(userId))) return;
            if ((await documentsEverSent(userId)) > DESIGN_OFFER_LIMIT) return;

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
          // Every row says what that setting is now, so they are all read
          // together rather than one query per row.
          const [account, pending, prefs] = await Promise.all([
            accountInForce(userId),
            pendingChange(userId),
            db().query<{
              default_due_days: number | null;
              template_id: string | null;
              invoice_number_start: number;
            }>(
              `SELECT default_due_days, template_id, invoice_number_start
                 FROM users WHERE id = $1`,
              [userId],
            ),
          ]);

          const p = prefs.rows[0];
          const design = TEMPLATES.find((t) => t.id === p?.template_id);

          // A tappable list rather than "reply with a number". One tap cannot be
          // mistyped, and it shows what each option does without a wall of text.
          if (ctx.phone) {
            const sent = await sendList(
              ctx.phone,
              settingsList({
                businessName,
                account,
                pending,
                dueDays: p?.default_due_days ?? defaults.behaviour.defaultDueDays,
                designName: design?.name ?? null,
                invoiceStart: p?.invoice_number_start ?? 1,
              }),
            );
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

        case "set_invoice_start": {
          await db().query(`UPDATE users SET invoice_number_start = $2 WHERE id = $1`, [
            userId,
            effect.start,
          ]);

          // What it will actually be, not what was asked for. The two differ
          // whenever somebody sets a number below one already issued, and
          // saying "done" over a change that did nothing is how they end up
          // sending it again.
          const { rows } = await db().query<{ next: number }>(
            `SELECT GREATEST(
                      COALESCE(MAX(d.number), 0) + 1,
                      (SELECT u.invoice_number_start FROM users u WHERE u.id = $1)
                    ) AS next
               FROM documents d WHERE d.user_id = $1 AND d.type <> 'sample'`,
            [userId],
          );
          const next = rows[0]?.next ?? effect.start;

          extra.push(
            next === effect.start
              ? `✅ Your next invoice will be ${b(`#${next}`)}.`
              : lines(
                  `✅ Your next invoice will be ${b(`#${next}`)}.`,
                  `Numbers only go forward, and you have already issued past ${b(`#${effect.start}`)}.`,
                ),
          );
          break;
        }

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
          buttons = VOICE.yesNo("Move it", "Keep current");
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

          /*
           * The upgrade card, for anybody who asks.
           *
           * Headed "Upgrade to Pro.", which is true whoever is reading it.
           * The other card is headed "Five done. Go unlimited." and belongs
           * only on the message that says they have run out — see the limit
           * card. Swapping the two would tell somebody on their second
           * invoice that they had finished five.
           */
          /*
           * One message, and the button is the payment.
           *
           * "Pay Now" used to be a reply button: tapping it sent the words
           * "Pay Now" into the chat, the bot answered with a second message,
           * and the link was on that one. Two taps and three bubbles to reach
           * a checkout, with the middle bubble saying nothing anybody needed.
           *
           * A message carries reply buttons or one link button, never both,
           * so making the offer's own button the link is the whole change.
           * It goes to our own page rather than to Monnify, because this
           * message will still be in the chat next week and a checkout URL
           * will not \u2014 see `proStartUrl`.
           */
          const offer = ctx.phone
            ? await sendCta(ctx.phone, {
                body: proOffer(used),
                label: "Pay Now",
                url: proStartUrl(userId),
                headerImage: UPGRADE_CARD,
              })
            : null;

          if (offer?.ok) {
            await recordOutbound(userId, offer.waMessageId, "sent", { kind: "interactive" });
            break;
          }

          /*
           * Without the card, then without the button.
           *
           * Meta documents image headers on cta_url and refuses them outright
           * on a list, so this is not taken on trust. Losing the picture is
           * worth keeping the button; losing the button costs the tap.
           */
          const plain = ctx.phone
            ? await sendCta(ctx.phone, {
                body: proOffer(used),
                label: "Pay Now",
                url: proStartUrl(userId),
              })
            : null;

          if (plain?.ok) {
            log.warn({ userId }, "Pro card rejected as a cta_url header; sent without it");
            await recordOutbound(userId, plain.waMessageId, "sent", { kind: "interactive" });
            break;
          }

          if (plain) log.warn({ userId, reason: plain.reason }, "Pro offer button failed");
          extra.push(proOffer(used));
          buttonsImage = UPGRADE_CARD;
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

          /*
           * A button, not a bare link.
           *
           * Tapping a URL in WhatsApp hands the person to whatever browser
           * their phone opens, and they then pay on a page that arrived with
           * no context. A cta_url opens in WhatsApp's own browser, so the
           * chat is still behind it and the payment finishes where it
           * started. It costs the same as the text message it replaces.
           */
          const button = ctx.phone
            ? await sendCta(ctx.phone, {
                body: payLinkCaption(),
                label: `Pay ${formatNaira(opened.priceKobo)}`,
                url: init.checkoutUrl,
              })
            : null;

          if (button?.ok) {
            await recordOutbound(userId, button.waMessageId, "sent", { kind: "interactive" });
            break;
          }

          if (button) {
            log.warn({ userId, reason: button.reason }, "pay button failed, sending the link");
          }
          extra.push(payLinkMessage(init.checkoutUrl));
          break;
        }
        case "save_logo":
          await handleLogo(userId, effect.mediaId, ctx.phone ?? "", log);
          break;

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
            if (!done.ok) { extra.push(cannotConvertMessage(number, done.why)); break; }

            extra.push(convertedMessage(done.value));

            /*
             * And then actually send it.
             *
             * Converting wrote an invoice with status 'sent' and sent_at set,
             * and sent nothing. The client never saw it, the user was left to
             * discover that "resend invoice 2" was how to issue their own
             * invoice, and the overdue sweep began counting down on somebody
             * who had never been billed.
             *
             * The same three things a confirmed draft does: the client's
             * inbox, the PDF, and one message to forward.
             */
            const made = await findForResend(userId, done.value.invoiceNumber);
            if (!made.ok) {
              log.error(
                { userId, invoice: done.value.invoiceNumber },
                "converted a quote and could not find the invoice to send",
              );
              break;
            }

            const inv = made.value;
            void emailDocumentToClient(inv.id, log).then((r) => {
              if (!r.ok && r.why !== "no_client_email" && r.why !== "not_pro") {
                log.error({ documentId: inv.id, why: r.why }, "client delivery failed");
              }
            });

            const link = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/${inv.publicToken}`;
            const forward = convertedForward(
              {
                number: inv.number,
                clientName: inv.clientName,
                totalKobo: inv.totalKobo,
                dueDate: due,
              },
              await partsFor(inv.id),
              link,
              ctx.today,
            );

            const pdf = await renderDocumentPdf(inv.id, log);
            if (pdf && ctx.phone) {
              const up = await uploadDocument(pdf.bytes, pdf.filename);
              if (up.ok) {
                const sent = await sendDocument(ctx.phone, up.mediaId, pdf.filename, forward);
                if (sent.ok) {
                  await recordOutbound(userId, sent.waMessageId, "sent", { kind: "document" });
                  break;
                }
              }
            }

            // No PDF or no upload: the link still works and is the part that
            // matters, so it goes as words rather than not at all.
            extra.push(forward);
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

  return {
    lines: extra,
    holdAt,
    failed,
    resolvedName,
    draftId,
    clearDraft,
    pendingBankChange,
    buttons,
    buttonsImage,
  };
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
 * The terms, agreed.
 *
 * The OptIn is required in the form, so a submission that arrives without it
 * is not somebody declining — it is a form that did not do what it says. It
 * falls back to asking rather than recording an agreement nobody gave, which
 * is the one thing this function must never do.
 *
 * What is recorded is the version, not the words. That is what makes it
 * possible to say later which terms a given person accepted.
 */
async function handleConsentForm(
  userId: string,
  phone: string,
  fields: Record<string, string>,
  log: FastifyBaseLogger,
): Promise<void> {
  // An OptIn comes back as the string "true", not a boolean.
  if (fields.agreed !== "true") {
    log.warn({ userId }, "consent form came back without an agreement");
    await saveConversation(userId, "onboarding:consent", {});
    await reply(userId, phone, [VOICE.confirmedAskConsent], log, VOICE.consentButtons());
    return;
  }

  await recordConsent(userId, legalConsentVersion);
  log.info({ userId, version: legalConsentVersion }, "consent recorded");

  await saveConversation(userId, "idle", {});

  // The same finish as the typed path: the card, and the way into an invoice.
  const outcome = await runEffects(
    [
      {
        type: "send_flow",
        key: "invoice",
        body: VOICE.doneCaption,
        cta: "Create invoice",
        image: SETUP_DONE_CARD,
        fallback: { line: VOICE.done, holdAt: "idle" },
      },
    ],
    userId,
    undefined,
    log,
    { today: todayIn(defaults.behaviour.timezone), phone },
  );

  if (outcome.lines.length) {
    await reply(userId, phone, outcome.lines, log, outcome.buttons, outcome.buttonsImage);
  }
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

  /*
   * The starting number is clamped rather than refused.
   *
   * It is one optional field on a form about something else, and rejecting the
   * whole submission over it would throw away a business name and an address
   * somebody had just typed. Out of range it falls back to what is already
   * stored, which for almost everybody is 1.
   *
   * Lowering it is allowed and simply does nothing: allocation takes the
   * greater of this and the next free number, so nothing can repeat.
   */
  const wanted = Number((fields.invoice_start ?? "").toString().replace(/\D/g, ""));
  const invoiceStart =
    Number.isInteger(wanted) && wanted >= 1 && wanted <= 2_000_000_000 ? wanted : null;

  await db().query(
    `UPDATE users
        SET address = NULLIF($2, ''),
            tin = NULLIF($3, ''),
            invoice_number_start = COALESCE($4, invoice_number_start)
      WHERE id = $1`,
    [userId, address, tin, invoiceStart],
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
        invoiceStart && invoiceStart > 1 ? row("Next invoice", `#${invoiceStart}`) : false,
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
  type: "invoice" | "quote" | "payment_request",
  userId: string,
  phone: string,
  fields: Record<string, string>,
  businessName: string | undefined,
  log: FastifyBaseLogger,
  today: Civil,
): Promise<void> {
  const clientName = (fields.client_name ?? "").trim();
  const email = (fields.client_email ?? "").trim().toLowerCase();
  const notes = (fields.notes ?? "").trim();
  const duePhrase = (fields.due_date ?? "").trim();

  // The form holds up to five items, four of them behind checkboxes, so what
  // arrives is sparse. A slot with words but no money stops the form rather
  // than being dropped — see form-lines.ts.
  const items = linesFromForm(fields);

  if (!items.ok) {
    log.warn({ userId, reason: items.reason }, "invoice form was incomplete");
    await reply(
      userId,
      phone,
      [
        items.reason === "half"
          ? para(
              `🤔 ${b(`Item ${items.position} is only half filled in.`)}`,
              items.hasDescription
                ? "It has the work but no amount. Add one, or untick it if you did not mean to bill for it."
                : "It has an amount but nothing saying what it is for.",
            )
          : para(
              `🤔 ${b("That form came back missing something.")}`,
              "A client, what the work is, and an amount. Try again, or just tell me in a sentence.",
            ),
      ],
      log,
    );
    return;
  }

  // Required in the form, so an empty one means the form was not the thing
  // that sent this. Saying which field rather than "something went wrong"
  // leaves them somewhere they can act.
  if (!clientName) {
    log.warn({ userId }, "invoice form came back with no client");
    await reply(
      userId,
      phone,
      [
        para(
          `🤔 ${b("That form came back without a client.")}`,
          "Who is it for? Try again, or just tell me in a sentence.",
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
    type,
    clientName,
    clientEmail: email || null,
    lines: items.lines,
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
  await reply(userId, phone, outcome.lines, log, outcome.buttons, outcome.buttonsImage);

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
async function detailsFor(userId: string): Promise<Record<string, string | number>> {
  const { rows } = await db().query<{
    business_name: string | null;
    email: string | null;
    address: string | null;
    tin: string | null;
    invoice_number_start: number;
  }>(
    `SELECT business_name, email, address, tin, invoice_number_start FROM users WHERE id = $1`,
    [userId],
  );

  const u = rows[0];
  return {
    business_name: u?.business_name ?? "",
    email: u?.email ?? "",
    address: u?.address ?? "",
    tin: u?.tin ?? "",
    // A number, because the field it fills is `input-type: "number"`.
    invoice_start: u?.invoice_number_start ?? 1,
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
  /** A picture above that last message. Only used when there are buttons. */
  buttonsImage?: string,
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

    let res = withButtons
      ? await sendButtons(to, { body, buttons, headerImage: buttonsImage })
      : await sendText(to, body);

    /*
     * A picture that will not send should not take the message with it.
     *
     * Meta fetches the header image from this API. A slow deploy, a cold
     * cache or a DNS blip and the whole interactive message is rejected. The
     * words underneath say everything the picture does, so they are still
     * worth sending without it.
     */
    if (!res.ok && withButtons && buttonsImage && !res.outsideWindow) {
      log.warn({ userId, reason: res.reason }, "card failed, sending it as words");
      res = await sendText(to, body);
    }

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
