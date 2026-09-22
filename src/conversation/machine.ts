/**
 * Conversation state machine (PRD section 5).
 *
 * A pure function: current state plus an inbound message gives the replies to
 * send, the next state, and any side effects to perform. Nothing here touches
 * the database, the network or the clock — persistence happens at the edge, so
 * every path through onboarding can be tested by calling a function.
 *
 * The rule that shapes the whole thing is section 5's last line: "A new command
 * always wins over a pending question, so users are never trapped." Someone
 * halfway through onboarding who types "help" gets help, not their bank details
 * question repeated at them.
 */

import { normalisePhone, type ReplyButton } from "../whatsapp/client.ts";
import { b, field, i, lines, para } from "../whatsapp/format.ts";
import type { Civil } from "../../core/dates.ts";
import { isDocumentIntent, type Parsed } from "../parser/schema.ts";
import type { Correction } from "../parser/corrections.ts";
import { parseAmountToKobo } from "../../core/amount.ts";
import { resolveDueDate } from "../../core/dates.ts";
import { titleCaseName } from "../../core/names.ts";
import { planIdFor } from "../whatsapp/flows/definitions.ts";
import { askFor, DEFAULT_DESCRIPTION } from "../documents/summary.ts";
import { defaults, env } from "../config.ts";

export type State =
  | "new"
  /** The onboarding form is open on their phone and we are waiting for it. */
  | "onboarding:form"
  | "onboarding:business_name"
  | "onboarding:bank"
  | "onboarding:confirm_account"
  | "onboarding:email"
  | "onboarding:verify_email"
  | "onboarding:consent"
  | "idle"
  /** A draft is on screen and the next message decides its fate (F6 step 3). */
  | "awaiting_confirm"
  /** One field is missing and it is the only thing being asked about (F3). */
  | "awaiting_field:client_name"
  | "awaiting_field:amount"
  | "awaiting_field:description"
  | "awaiting_field:due_date"
  /** Settings (F17). The bank change is the one with a code in front of it. */
  | "settings:menu"
  | "settings:business_name"
  | "settings:due_days"
  | "settings:invoice_number"
  | "settings:bank_code"
  | "settings:bank_details"
  | "settings:bank_confirm"
  | "settings:delete_confirm"
  | "paused";

export type Context = {
  businessName?: string;
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  resolvedAccountName?: string;
  email?: string;
  /** Wrong answers in a row on the current step. */
  attempts?: number;

  /**
   * The document being built, before it is worth a row in the database.
   *
   * It lives here through the awaiting_field steps and is written as a draft
   * only once there is enough to show a summary. A half-built document in
   * `documents` would be a draft the user never saw.
   */
  doc?: PendingDoc;
  /** The draft on screen, once there is one. */
  draftId?: string;

  /**
   * A bank change in progress (F17).
   *
   * Filled in by the effect that resolves the account and creates the
   * subaccount, so the turn that says "yes" has everything it needs and
   * committing is only a scheduling decision.
   */
  changing?: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    subAccountCode: string;
  };
};

/** A document under construction. Amounts are kobo; nothing here is a string. */
export type PendingDoc = {
  type: "invoice" | "quote" | "payment_request";
  clientName?: string;
  clientEmail?: string | null;
  lines: { description: string; qty: number; unitAmountKobo: number }[];
  /** Set when an amount arrived with no description to attach it to. */
  totalKobo?: number;
  dueDate?: Civil | null;
  vatPercent?: number | null;
  depositPercent?: number | null;
  /** Equal payments. Never set alongside `depositPercent`; see `shapeFor`. */
  instalments?: number | null;
  passFeesToClient?: boolean;
  notes?: string | null;
};

/**
 * Work the caller must do. The machine decides *what* should happen; the caller
 * owns the side effects, which keeps this function pure and testable.
 */
export type Effect =
  | {
      type: "resolve_account";
      bankQuery: string;
      accountNumber: string;
      /**
       * Whether an email is already on file for this conversation.
       *
       * The setup form collects the email and the bank together. When the bank
       * half fails — a typo, a bank that will not resolve — the conversation
       * picks up the bank on its own, and the email it already has must not be
       * asked for again. The effect writes the message, so it has to be told.
       */
      haveEmail?: boolean;
    }
  | { type: "create_subaccount" }
  | { type: "send_email_code"; email: string }
  /**
   * Open a Flow on the user's phone.
   *
   * The flow's published id lives in `config`, not here: a flow recreated
   * after a mistake gets a new id, and the machine is a pure function with no
   * way to read a table. The caller looks it up and falls back to asking in
   * words if the flow is missing, so a Flow that was never published cannot
   * strand somebody at their first message.
   */
  | {
      type: "send_flow";
      key: "onboarding" | "business_details" | "invoice";
      body: string;
      cta: string;
      /**
       * A picture above the message.
       *
       * Only the setup invitation has one. It is somebody's first sight of
       * this product, usually after a friend sent them a number and nothing
       * else, and one message that shows what this is beats three that
       * describe it.
       */
      image?: string;
      /**
       * Values the form opens on.
       *
       * What makes "Change it" an edit rather than a re-type. Sent as the
       * screen's `data`, which its Form reads through `init-values`.
       */
      data?: Record<string, string | number | boolean>;
      /**
       * What to say instead when there is no published Flow.
       *
       * Every Flow needs one, because "no form" is the normal state of this
       * account until Meta verifies the business — and the answer differs by
       * Flow. Losing the invoice form should leave somebody with the typed
       * template, not with an apology about payouts.
       */
      fallback?: { line: string; holdAt: State };
    }
  | { type: "verify_email_code"; email: string; code: string }
  | { type: "record_consent"; version: string }
  | {
      type: "show_help";
      /**
       * The typed menu, for when the list cannot be sent.
       *
       * Same shape as `send_flow`'s fallback and for the same reason: an
       * interactive message is a thing that can fail, and "what can you do?"
       * is the worst question in the product to answer with silence.
       */
      fallback: string;
    }
  /** Write the draft and show its summary (F6 step 2). */
  | { type: "save_draft"; doc: PendingDoc }
  /** Number it, make the link, send it (F6 step 4). */
  | { type: "send_document" }
  | { type: "discard_draft" }
  | { type: "show_debtors" }
  | { type: "show_summary" }
  | { type: "show_settings" }
  /** F24: the link to the design picker. */
  | { type: "show_designs" }
  /** F21: take the user's logo off their documents. */
  | { type: "remove_logo" }
  | { type: "show_upgrade" }
  | { type: "show_referral" }
  | { type: "document_action"; intent: Parsed["intent"]; number: number | null }
  /* -- Settings (F17) ---------------------------------------------------- */
  | { type: "set_business_name"; name: string }
  | { type: "set_due_days"; days: number }
  | { type: "set_invoice_start"; start: number }
  /** A code to the verified email before anything about the bank moves. */
  | { type: "send_bank_change_code" }
  | { type: "verify_bank_change_code"; code: string }
  /** Resolve the new account, for the user to confirm by name. */
  | { type: "resolve_new_account"; bankQuery: string; accountNumber: string }
  /** Schedule it, alert, and tell them when it takes effect. */
  | { type: "commit_bank_change" }
  | { type: "cancel_bank_change" }
  | { type: "delete_account" }
  /* -- Pro (F18) --------------------------------------------------------- */
  | { type: "start_pro"; method: "link" | "deduct_from_invoice" };

export type Step = {
  /**
   * Sent before the effects run, not after.
   *
   * Reserved for a wait long enough that the typing bubble is not enough on its
   * own. Nothing currently uses it: the bank lookup, the subaccount and the code
   * send are all about a second, which the typing bubble covers for free. A
   * "one moment" is a chargeable message from October 2026, and it has to buy
   * more reassurance than the free thing already does.
   */
  ack?: string[];
  /** Sent once the effects are done, and dropped if one of them held. */
  replies: string[];
  /**
   * Tappable answers under the last message of the turn.
   *
   * "Reply *yes* to send it" asks somebody to read the instruction, remember
   * the word, open the keyboard, spell it and send. Each of those is a place
   * where a person stops, and the last is where they type "yeah" and get asked
   * again. A button is one tap and cannot be mistyped.
   *
   * Dropped along with `replies` when an effect holds the conversation, since
   * the question they answered no longer stands.
   */
  buttons?: ReplyButton[];
  next: State;
  context: Context;
  effects: Effect[];
};

export type Inbound = {
  text: string;
  profileName?: string;
  /**
   * What the parser made of the message, where the caller ran it.
   *
   * The parser is asynchronous and this function is not, so the reading
   * happens at the edge and the decision happens here. That keeps every
   * branch below testable by calling a function with a fixed parse.
   */
  parsed?: Parsed;
  /** A correction read against the draft on screen, if there is one. */
  correction?: Correction | null;
  /** Set when nothing could read the message (F3, section 15). */
  parseFailed?: "too_long" | "unavailable";
  /** Today in Lagos, for the default due date. */
  today?: Civil;
};

/* -------------------------------------------------------------------------- */
/* Global commands                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The legal links, written in full.
 *
 * WhatsApp linkifies a URL it recognises, and "balans.ng/terms" is not
 * reliably one — it renders as plain text somebody has to retype. Section 12
 * requires these reachable at the moment of consent, and a link that cannot be
 * tapped is not reachable on a phone.
 */
const site = env.SITE_URL.replace(/[/]$/, "");

/**
 * The card that rides on top of the setup invitation.
 *
 * Fetched by Meta, from this same API. A URL rather than an uploaded media id
 * because an id expires after thirty days and the failure would arrive a month
 * after anybody last looked at this.
 */
const brand = (file: string): string =>
  `${env.PUBLIC_BASE_URL.replace(/[/]$/, "")}/brand/${file}`;

const WELCOME_CARD = brand("welcome.png");
const SETUP_DONE_CARD = brand("setup-done.png");
const TERMS_URL = site + "/terms";
const PRIVACY_URL = site + "/privacy";

const HELP = /^(help|menu|what can you do|abeg help)\b/i;
const CANCEL = /^(cancel|stop|start over|restart)\b/i;
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|hola|howfa|how far)\b/i;

/**
 * Everything the bot says during setup.
 *
 * Two things shape the copy. Bold marks values and actions, so a glance finds
 * the thing to check and the thing to do. And a turn is one message: WhatsApp
 * bills Nigeria per service message from 1 October 2026, so a "Got it" on its
 * own line is a real cost for something that reads better joined to the
 * question after it. PRD section 15 puts the whole of setup at six messages.
 */
export const VOICE = {
  /** The invitation that carries the setup form. */
  /*
   * Short on purpose: the card above it already says welcome, and already
   * lists the three things. Saying them again underneath is the same sentence
   * twice, and the only thing left to say is what to do next.
   */
  setupInvite: para(`\u{1F44B} ${b("Tap below to set up.")}`, "It takes about a minute."),

  /** Somebody who backed out and is being offered the same beginning again. */
  setupAgain: para(
    `\u{1F44B} ${b("No problem, starting again.")}`,
    "Tap below. It takes about a minute.",
  ),

  /** The same, for somebody whose first message was an instruction. */
  setupFirst: para(
    "👋 Let us get you set up first, then I can do that.",
    b("Tap below. It takes about a minute."),
  ),

  /** They closed the form, or would rather type. Both are fine. */
  setupByHand: para(
    "📝 No problem, we can do it here instead.",
    lines(b("What is your business called?"), "This is the name your clients see on every invoice."),
  ),

  askBusinessName: para(
    "👋 Welcome to Balans.",
    lines(
      b("What is your business called?"),
      "This is the name your clients see on every invoice.",
    ),
  ),

  /** The confirmation and the next question, in one message rather than two. */
  gotNameAskBank: (name: string) =>
    para(
      `✅ ${field("Business", name)}`,
      lines(
        b("Which bank should your money go to?"),
        `Send the bank and account number together — like ${b("GTBank 0123456789")}.`,
      ),
    ),

  askBank: lines(
    `🏦 ${b("Which bank should your money go to?")}`,
    `Send the bank and account number together — like ${b("GTBank 0123456789")}.`,
  ),

  askEmail: lines(
    `✉️ ${b("What email address should we use?")}`,
    "Your receipts and invoice copies go there.",
  ),

  /*
   * The one message with no emoji anywhere on it.
   *
   * Three of them landed here — one opening the message and one on each
   * button — and two were near-identical envelopes stacked on top of each
   * other. That is the failure the one-emoji rule exists to prevent, arriving
   * through the back door: the rule counts per message, and a message plus
   * its buttons is what somebody actually looks at.
   *
   * It is also the one screen where nothing needs decorating. Somebody is
   * copying six digits out of an email. The only thing that matters is which
   * address they went to, and it is already the only bold thing here.
   */
  askCode: (email: string) =>
    para(`Code sent to ${b(email)}.`, lines(b("Send me the 6 digits."), "No code?")),

  /** The two ways out of the code step, as taps. */
  codeButtons: (): ReplyButton[] => [
    { id: "resend", title: "Send again" },
    { id: "change", title: "Other email" },
  ],

  /** Confirmation, the terms and the thing to reply: one message, not three. */
  confirmedAskConsent: para(
    "✅ Email confirmed.",
    lines("One last thing — our terms and privacy notice:", TERMS_URL, PRIVACY_URL),
    b("Agree to finish?"),
  ),

  askConsent: para(
    lines("📄 Our terms and privacy notice:", TERMS_URL, PRIVACY_URL),
    b("Agree to finish?"),
  ),

  /*
   * One button, not two. There is no "decline" that leads anywhere — refusing
   * the terms means no account — so offering it would be a door into a room
   * that does not exist. Somebody who does not agree simply stops.
   */
  consentButtons: (): ReplyButton[] => [{ id: "I agree", title: "✅ I agree" }],

  /** Yes and no, wherever a question has exactly those two answers. */
  yesNo: (yes = "✅ Yes", no = "❌ No"): ReplyButton[] => [
    { id: "yes", title: yes },
    { id: "no", title: no },
  ],

  /**
   * Under the card, which already shows the example and says what to type.
   *
   * `done` below is the same message without one, for when the form cannot be
   * sent — there is no card either in that case, so it has to carry the
   * example itself.
   */
  doneCaption: para(
    `\u{1F389} ${b("You are set up.")}`,
    "Type it like a text, or tap below.",
  ),

  /** Refusing a command that has nothing to work with yet. */
  setupBeforeCommands: `\u{1F512} ${b("That one works once you are set up.")}`,

  /**
   * Under the cheat sheet, which is the message.
   *
   * The picture already lists the ten and shows the example, so the only
   * things left to say are the two the picture cannot: that the buttons work,
   * and that "/" draws a list above the keyboard without sending anything.
   */
  helpCaption: para(
    `\u{1F4CB} ${b("Save this one.")}`,
    'Tap below, type / for the full list, or just say it.',
  ),

  /** Under the form invitation, which is the whole message. */
  changeInvite: para(
    `✏️ ${b("Change anything you like.")}`,
    "Or just say it: make it 400k, due next Friday.",
  ),

  /** The same moment, with no form to open. */
  changeByHand: lines(
    `✏️ ${b("What should I change?")}`,
    `Say it however you like — ${b("make it 400k")}, ${b("due next Friday")}, ${b("client is Zenith Homes")}.`,
  ),

  done: para(
    `🎉 ${b("You are set up.")}`,
    lines(
      "Send me a line like:",
      i("Invoice Zenith Homes 350k for duplex 3D render, due Friday"),
      "and I will draft it for you.",
    ),
  ),

  /**
   * Everything the bot does, in one message.
   *
   * Returned by "/" as well as "help", because "/" is the convention people
   * already try when they are looking for what a thing can do — and a
   * product whose whole surface is a text box has to answer that question
   * somewhere.
   *
   * The commands are listed with slashes and the example without one, because
   * both work and the sentence is the better habit.
   */
  helpIdle: para(
    `📋 ${b("What I can do")}`,
    lines(
      b("Getting paid"),
      "/invoice — bill a client",
      "/quote — send a quote",
      "/collect — a quick payment request",
    ),
    lines(
      b("Keeping track"),
      "/owed — who owes you",
      "/summary — how this month went",
      "/status — check one invoice",
    ),
    lines(
      b("Your account"),
      "/settings — name, bank, due days",
      "/design — how your invoices look",
      "/pro — unlimited invoices",
    ),
    lines(
      "Or just say it:",
      i("Invoice Tunde 20k for logo design, due Friday"),
    ),
  ),

  /** F6: a draft went away, and it should be obvious that it did. */
  draftDiscarded: lines(
    "🗑️ Dropped that one.",
    `Send me another whenever you are ready — like ${b("Invoice Tunde 20k for logo")}.`,
  ),

  nothingPending: lines(
    "📭 There is no draft waiting.",
    `Send me a line like ${b("Invoice Tunde 20k for logo, due Friday")}.`,
  ),

  /** Section 15: when the model is down, say so rather than guessing. */
  cannotRead: para(
    `🤔 ${b("I could not read that one.")}`,
    lines(
      `Try the short form: ${b("Invoice Tunde 20k for logo, due Friday")}`,
      `Or reply ${b("help")}.`,
    ),
  ),

  tooLong: lines(
    `\u2702\ufe0f ${b("That message is too long for me.")}`,
    "Send the short version — who, how much, what for, and when.",
  ),

  outOfScope: para(
    `👋 ${b("I only do quotes, invoices and payments.")}`,
    lines(
      `Try: ${i("Invoice Tunde 20k for logo design, due Friday")}`,
      `Or ask: ${i("who owes me?")}`,
    ),
  ),

  /**
   * Invoice designs are on the landing page, so people ask for them.
   *
   * Answered as its own thing rather than falling into settings, which has
   * nothing to do with how an invoice looks and cannot help.
   */
  designs: para(
    `🎨 ${b("Pick how your invoices look.")}`,
    lines(
      "Open the link to see each design with your own details in it.",
      "Whatever you choose is used on every invoice you send after that.",
    ),
  ),

  notBuiltYet: (what: string) =>
    lines(`🚧 ${b(what)} is not built yet.`, "It is coming — the rest works now."),

  /* -- Settings (F17) ---------------------------------------------------- */

  /**
   * The form, sent when somebody asks for a document with no details.
   *
   * One message instead of four questions. Each question is a real charge from
   * October 2026, and four of them cost more than the minimum fee on the
   * invoice they are collecting. It is also clearer: "How much?" invites
   * "500$", while "Amount:" beside an example does not.
   */
  invoiceForm: para(
    `🧾 ${b("New invoice")}`,
    "Copy this, fill it in, and send it back:",
    lines("Client:", "Client email:", "Amount:", "For:", "Due:"),
    lines(
      `Only ${b("Client")} and ${b("Amount")} are needed.`,
      i("With an email, I send it to them for you."),
      i("Or just say it: Invoice Tunde 20k for logo, due Friday"),
    ),
  ),

  /**
   * The message the invoice Flow arrives on.
   *
   * Short, because the form is the message. Everything the template spells
   * out is a label inside it, and repeating them here would have somebody
   * reading the invoice twice before they have written it once.
   *
   * The sentence is still offered, and still works. It is the faster road for
   * most invoices, and the form must not look like it replaced one.
   */
  invoiceFormBody: para(
    `\u{1F9FE} ${b("New invoice")}`,
    "Tap below to fill it in.",
    i("Or just say it: Invoice Tunde 20k for logo, due Friday"),
  ),

  quoteForm: para(
    `📄 ${b("New quote")}`,
    "Copy this, fill it in, and send it back:",
    lines("Client:", "Client email:", "Amount:", "For:", "Valid until:"),
    lines(
      `Only ${b("Client")} and ${b("Amount")} are needed.`,
      i("Or just say it: Quote Zenith 350k for renders"),
    ),
  ),

  requestForm: para(
    `💰 ${b("Payment request")}`,
    "Copy this, fill it in, and send it back:",
    lines("Client:", "Amount:", "For:"),
    i("Or just say it: Collect 20k from Tunde"),
  ),

  askNewBusinessName: lines(
    `🏷️ ${b("What should your business be called?")}`,
    "This changes the name on every invoice from now on.",
  ),

  askInvoiceStart: lines(
    `\u{1F522} ${b("What number should your next invoice be?")}`,
    `Useful if you are carrying on from another tool — send ${b("1047")} and the next one is #1047.`,
  ),

  askDueDays: lines(
    `📅 ${b("How many days should invoices be due in?")}`,
    `A number between 0 and 180. Most people use ${b("7")}.`,
  ),

  /**
   * The code comes first, before any bank details are even asked for.
   *
   * That ordering is deliberate: somebody who has taken over the WhatsApp
   * number gets stopped here, having learned nothing about the account.
   */
  askBankChangeCode: para(
    `🔐 ${b("Changing where your money goes needs a code.")}`,
    lines(
      "We have sent a 6-digit code to your verified email.",
      "Send it here to carry on.",
    ),
    `Reply ${b("cancel")} to leave things as they are.`,
  ),

  askNewBank: lines(
    `🏦 ${b("Which bank and account number should we pay into?")}`,
    `Send them together — like ${b("GTBank 0123456789")}.`,
  ),

  bankChangeAbandoned: lines(
    `🔒 ${b("Nothing changed.")}`,
    "Your money still goes to the account you set up.",
  ),

  settingsClosed: lines(`\u2699\ufe0f ${b("Closed settings.")}`, "Nothing changed."),

  settingsUnknown: lines(
    `🔢 Reply with a ${b("number")} from the list.`,
    `Or ${b("cancel")} to leave settings.`,
  ),

  /** F17: "confirm twice", and the second one is not a yes/no. */
  confirmDelete: para(
    `⚠️ ${b("This closes your Balans account.")}`,
    lines(
      "Open invoices are cancelled. Your payout account is disconnected.",
      "Records of money that moved are kept, as the law requires.",
    ),
    `If you are sure, send exactly: ${b("delete my account")}`,
  ),

  deleteAbandoned: `\u2705 ${b("Your account is untouched.")}`,

  paused: para(
    `⏸️ ${b("Your account is on hold")} while we review it.`,
    lines(
      "Payments on invoices you already sent still work.",
      "Email hello@balans.ng and a person will look at it.",
    ),
  ),
};

/* -------------------------------------------------------------------------- */

export function step(state: State, context: Context, msg: Inbound, consentVersion: string): Step {
  const text = msg.text.trim();

  // A paused account can still ask for help, and nothing else (section 5).
  if (state === "paused") {
    return { replies: [VOICE.paused], next: state, context, effects: [] };
  }

  /*
   * Commands come before the pending question, so nobody gets stuck.
   *
   * Keyed off the parsed intent as well as the pattern, because the pattern
   * knows "help" and "menu" and the command reader knows "/" — and "/" is the
   * one people actually try. It only worked from idle before, which meant it
   * failed precisely when somebody was part-way through a draft and looking
   * for a way out. That is the situation the menu exists for.
   *
   * `context` and `state` are both passed through untouched: asking what this
   * thing can do must never cost somebody the draft they were halfway through.
   */
  if (HELP.test(text) || msg.parsed?.intent === "help") {
    if (state.startsWith("onboarding")) {
      // Mid-onboarding, help is about the question on the screen. Offering the
      // whole menu there invites somebody to wander off a form they are three
      // fields into — and half of that menu needs an account to work.
      return { replies: [onboardingHelp(state)], next: state, context, effects: [] };
    }
    return {
      replies: [],
      next: state,
      context,
      effects: [{ type: "show_help", fallback: VOICE.helpIdle }],
    };
  }

  /*
   * A slash command, mid-setup.
   *
   * "/pro" was taken as a business name and saved — the account came out
   * called "/pro", because the question asked for a name and the answer was
   * eighty characters or fewer, which was the whole of the check.
   *
   * Nothing behind these commands works yet anyway: there is no bank to be
   * paid into, no plan to upgrade, nothing owed. So they are refused with the
   * question repeated, rather than swallowed as an answer to it.
   *
   * Only the slash form. Somebody's business really could be called Pro, and
   * at this exact moment they are being asked for its name — so a bare word
   * is an answer and a slashed one is a command. The leading slash is the
   * only thing that tells them apart, which is why `takeBusinessName` refuses
   * it too rather than trusting this.
   *
   * After HELP, so "/help" still explains the question on screen, and after
   * CANCEL, so somebody can still get out.
   */
  if (state.startsWith("onboarding") && text.trim().startsWith("/")) {
    return {
      replies: [para(VOICE.setupBeforeCommands, onboardingHelp(state))],
      next: state,
      context,
      effects: [],
    };
  }

  if (CANCEL.test(text) && state.startsWith("onboarding")) {
    /*
     * Starting again means starting again.
     *
     * It used to answer with the first typed question, which is a different
     * and worse beginning than the one a new number gets — the card, what
     * this is for, and a button. Somebody who has just backed out of setup is
     * exactly the person least sure about it, and handing them a bare
     * question is the wrong half of the product to show.
     *
     * So: the same message, the same card, the same button. Only the words
     * differ, and only to acknowledge that they asked.
     */
    return {
      replies: [],
      next: "onboarding:form",
      context: {},
      effects: [
        {
          type: "send_flow",
          key: "onboarding",
          body: VOICE.setupAgain,
          cta: "Set up Balans",
          image: WELCOME_CARD,
          // Without a form there is no card either, so the fallback is what
          // this branch used to say on its own.
          fallback: {
            line: para("No problem, we will start again.", VOICE.askBusinessName),
            holdAt: "onboarding:business_name",
          },
        },
      ],
    };
  }

  switch (state) {
    case "new":
      /*
       * Anything at all begins onboarding. A greeting is the common case, but
       * someone who opens with "invoice Tunde 20k" should not be told off:
       * take them through setup and their instruction still stands afterwards.
       *
       * Setup is a form rather than six questions. Business name, email, bank
       * and account number are four things they already know, and asking for
       * them one at a time is four chances to wander off — plus four
       * chargeable messages from October 2026.
       */
      return {
        replies: [],
        next: "onboarding:form",
        context: {},
        effects: [
          {
            type: "send_flow",
            key: "onboarding",
            body: GREETING.test(text) ? VOICE.setupInvite : VOICE.setupFirst,
            cta: "Set up Balans",
            image: WELCOME_CARD,
          },
        ],
      };

    case "onboarding:form":
      /*
       * The form is open and this is a typed message instead of a submission.
       *
       * Either they closed it or they would rather type, and both are fine —
       * the form is the fast path, never the only one.
       *
       * A greeting means they want the question. Anything else is almost
       * certainly already the answer to it, and throwing that away to ask for
       * it again is the rudest thing this branch could do.
       */
      if (GREETING.test(text)) {
        return { replies: [VOICE.setupByHand], next: "onboarding:business_name", context: {}, effects: [] };
      }
      return takeBusinessName(text, context, msg);

    case "onboarding:business_name":
      return takeBusinessName(text, context, msg);

    case "onboarding:bank":
      return takeBank(text, context);

    case "onboarding:confirm_account":
      return confirmAccount(text, context);

    case "onboarding:email":
      return takeEmail(text, context);

    case "onboarding:verify_email":
      return takeCode(text, context);

    case "onboarding:consent":
      return takeConsent(text, context, consentVersion);

    case "idle": {
      if (GREETING.test(text)) {
        // "hey" is somebody opening the chat with nothing particular in mind.
        // It deserves the same tappable menu as "/", for the same reason: the
        // answer to "what is this" should be something you can act on rather
        // than a list of words to retype.
        return {
          replies: [],
          next: "idle",
          context,
          effects: [{ type: "show_help", fallback: VOICE.helpIdle }],
        };
      }
      // Answers to the Pro offer. Read here rather than by the model, because
      // "pay now" is a decision about money and its meaning is fixed.
      const pro = asProChoice(text);
      if (pro) {
        return { replies: [], next: "idle", context, effects: [{ type: "start_pro", method: pro }] };
      }
      return fromParsed(msg, context, today(msg));
    }

    case "awaiting_field:client_name":
    case "awaiting_field:amount":
    case "awaiting_field:description":
    case "awaiting_field:due_date":
      return takeMissingField(state, text, context, msg);

    case "awaiting_confirm":
      return atConfirm(text, context, msg);

    case "settings:menu":
      return atSettingsMenu(text, context, msg);

    case "settings:business_name":
      return takeNewBusinessName(text, context);

    case "settings:invoice_number":
      return takeInvoiceNumber(text, context);

    case "settings:due_days":
      return takeDueDays(text, context);

    case "settings:bank_code":
      return takeBankChangeCode(text, context);

    case "settings:bank_details":
      return takeNewBankDetails(text, context);

    case "settings:bank_confirm":
      return confirmNewBank(text, context, msg);

    case "settings:delete_confirm":
      return confirmDeletion(text, context);
  }
}

/* -------------------------------------------------------------------------- */
/* Settings (F17)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The menu.
 *
 * Numbered, because a list of nine phrases to type is a list nobody reads. The
 * words still work: "change bank" gets there without counting.
 */
function atSettingsMenu(text: string, ctx: Context, msg: Inbound): Step {
  const s = text.trim().toLowerCase();
  const now = today(msg);

  /*
   * The menu's own rows are read before anything else.
   *
   * "change bank" is both a row on this menu and a phrase that opens the
   * menu. Checking for an escaping command first saw the second reading,
   * reopened settings, and left somebody tapping the same row forever.
   */
  if (/^(1|business name|name|change (my )?(business )?name)\b/.test(s)) {
    return { replies: [VOICE.askNewBusinessName], next: "settings:business_name", context: ctx, effects: [] };
  }

  if (/^(2|bank|change (my )?bank|payout|account)\b/.test(s)) {
    // F17 step 1: nothing about the bank moves before the code.
    return {
      replies: [],
      next: "settings:bank_code",
      context: { ...ctx, attempts: 0 },
      effects: [{ type: "send_bank_change_code" }],
    };
  }

  if (/^(3|due|due days|payment terms)\b/.test(s)) {
    return { replies: [VOICE.askDueDays], next: "settings:due_days", context: ctx, effects: [] };
  }

  if (/^(4|design|designs|invoice design|templates?)\b/.test(s)) {
    return { replies: [], next: "idle", context: forget(ctx), effects: [{ type: "show_designs" }] };
  }

  if (/^(5|invoice number|invoice no|numbering|number)\b/.test(s)) {
    return {
      replies: [VOICE.askInvoiceStart],
      next: "settings:invoice_number",
      context: ctx,
      effects: [],
    };
  }

  if (/^(6|delete|close|delete my account|close my account)\b/.test(s)) {
    return { replies: [VOICE.confirmDelete], next: "settings:delete_confirm", context: ctx, effects: [] };
  }

  if (/^(cancel|back|never ?mind|exit|done|no)\b/.test(s)) {
    return { replies: [VOICE.settingsClosed], next: "idle", context: forget(ctx), effects: [] };
  }

  // Nothing on the menu. Now a genuinely different instruction can win.
  const escape = commandEscape(msg, ctx, now);
  if (escape) return escape;

  return retry("settings:menu", ctx, VOICE.settingsUnknown);
}

function takeNewBusinessName(text: string, ctx: Context): Step {
  const name = text.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) {
    return retry("settings:business_name", ctx, VOICE.askNewBusinessName);
  }
  return {
    replies: [],
    next: "idle",
    context: { ...ctx, businessName: titleCaseName(name), attempts: 0 },
    effects: [{ type: "set_business_name", name: titleCaseName(name) }],
  };
}

/**
 * The number the next invoice takes.
 *
 * Only ever forward: allocation takes the greater of this and the next free
 * number, so a value below what has been issued changes nothing rather than
 * colliding with an invoice already sent. Said out loud in the confirmation,
 * because somebody who types 5 after issuing 40 needs to know why nothing
 * appeared to happen.
 */
function takeInvoiceNumber(text: string, ctx: Context): Step {
  const start = Number(text.trim().replace(/[^0-9]/g, ""));
  if (!Number.isInteger(start) || start < 1 || start > 2_000_000_000) {
    return retry("settings:invoice_number", ctx, VOICE.askInvoiceStart);
  }
  return {
    replies: [],
    next: "idle",
    context: { ...ctx, attempts: 0 },
    effects: [{ type: "set_invoice_start", start }],
  };
}

function takeDueDays(text: string, ctx: Context): Step {
  const days = Number(text.trim().replace(/[^0-9]/g, ""));
  if (!Number.isInteger(days) || days < 0 || days > 180) {
    return retry("settings:due_days", ctx, VOICE.askDueDays);
  }
  return {
    replies: [],
    next: "idle",
    context: { ...ctx, attempts: 0 },
    effects: [{ type: "set_due_days", days }],
  };
}

/** F17 step 1: the code from the verified email, before anything else. */
function takeBankChangeCode(text: string, ctx: Context): Step {
  const s = text.trim();

  if (/^(cancel|stop|never ?mind|no)\b/i.test(s)) {
    return { replies: [VOICE.bankChangeAbandoned], next: "idle", context: forget(ctx), effects: [] };
  }

  const code = s.replace(/\D/g, "");
  if (code.length !== 6) {
    return retry("settings:bank_code", ctx, VOICE.askBankChangeCode);
  }

  return {
    replies: [],
    next: "settings:bank_details",
    context: { ...ctx, attempts: 0 },
    effects: [{ type: "verify_bank_change_code", code }],
  };
}

/** Same shape as onboarding, because it is the same question. */
function takeNewBankDetails(text: string, ctx: Context): Step {
  const account = text.match(/\b(\d{10})\b/)?.[1];
  const bank = text.replace(/\b\d{10}\b/, "").replace(/\s+/g, " ").trim();

  if (/^(cancel|stop|never ?mind)\b/i.test(text.trim())) {
    return { replies: [VOICE.bankChangeAbandoned], next: "idle", context: forget(ctx), effects: [] };
  }

  if (!account || bank.length < 2) {
    return retry("settings:bank_details", ctx, VOICE.askNewBank);
  }

  return {
    replies: [],
    next: "settings:bank_confirm",
    // `changing` is filled in by the effect, which is the only thing that
    // knows the resolved name and the subaccount it created.
    context: { ...ctx, attempts: 0 },
    effects: [{ type: "resolve_new_account", bankQuery: bank, accountNumber: account }],
  };
}

function confirmNewBank(text: string, ctx: Context, msg: Inbound): Step {
  if (/^(yes|yeah|yep|correct|that is right|na me|ok|okay|confirm)\b/i.test(text.trim())) {
    return {
      replies: [],
      next: "idle",
      context: forget({ ...ctx, attempts: 0 }),
      effects: [{ type: "commit_bank_change" }],
    };
  }
  if (/^(no|nope|wrong|not me|cancel|stop)\b/i.test(text.trim())) {
    return {
      replies: [VOICE.bankChangeAbandoned],
      next: "idle",
      context: forget(ctx),
      effects: [{ type: "cancel_bank_change" }],
    };
  }
  /*
   * Section 5: a new command wins, so nobody is trapped.
   *
   * Checked after yes and no, never before — "no" is a row on this question
   * and also a global cancel, and the question has to win that one. Anything
   * genuinely different abandons the change, which is safe because nothing
   * has been scheduled yet: the account was resolved and a subaccount made,
   * and neither is where the money goes until this is confirmed.
   */
  const escape = commandEscape(msg, forget(ctx), today(msg));
  if (escape) return escape;

  return {
    ...retry(
      "settings:bank_confirm",
      ctx,
      ctx.changing?.accountName
        ? `🤔 Is ${b(ctx.changing.accountName)} the right account?`
        : "🤔 Is that the right account?",
    ),
    buttons: VOICE.yesNo("✅ That's me", "❌ Not me"),
  };
}

/** F17: "confirm twice". This is the second. */
function confirmDeletion(text: string, ctx: Context): Step {
  const s = text.trim().toLowerCase();
  if (s === "delete my account") {
    return { replies: [], next: "idle", context: forget(ctx), effects: [{ type: "delete_account" }] };
  }
  if (/^(no|cancel|stop|never ?mind)\b/.test(s)) {
    return { replies: [VOICE.deleteAbandoned], next: "idle", context: forget(ctx), effects: [] };
  }
  return retry("settings:delete_confirm", ctx, VOICE.confirmDelete);
}

/* -------------------------------------------------------------------------- */
/* Documents (F6)                                                             */
/* -------------------------------------------------------------------------- */

const today = (msg: Inbound): Civil =>
  msg.today ?? { y: 1970, m: 1, d: 1 }; // the caller always supplies it

/**
 * Acts on what the parser made of the message.
 *
 * Every branch that is not a document either runs now or says plainly that it
 * does not. Silence and vague deferral are both worse than one honest line.
 */
function fromParsed(msg: Inbound, ctx: Context, now: Civil): Step {
  if (msg.parseFailed === "too_long") {
    return { replies: [VOICE.tooLong], next: "idle", context: ctx, effects: [] };
  }
  if (msg.parseFailed || !msg.parsed) {
    return { replies: [VOICE.cannotRead], next: "idle", context: ctx, effects: [] };
  }

  const p = msg.parsed;

  switch (p.intent) {
    case "create_invoice":
    case "create_quote":
    case "payment_request":
      return startDocument(p, ctx, now);

    case "help":
      return {
        replies: [],
        next: "idle",
        context: ctx,
        effects: [{ type: "show_help", fallback: VOICE.helpIdle }],
      };

    case "debtors":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_debtors" }] };
    case "summary":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_summary" }] };
    case "settings":
      return {
        replies: [],
        next: "settings:menu",
        context: ctx,
        effects: [{ type: "show_settings" }],
      };
    case "upgrade":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_upgrade" }] };
    case "referral":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_referral" }] };
    case "templates":
      // The link is built by the effect, which is the only place that knows
      // the user's own picker token.
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_designs" }] };

    case "remove_logo":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "remove_logo" }] };

    case "status":
    case "stop_reminders":
    case "cancel_document":
    case "resend_document":
    case "convert_quote":
    case "edit_document":
    case "record_payment":
      return {
        replies: [],
        next: "idle",
        context: ctx,
        effects: [{ type: "document_action", intent: p.intent, number: p.documentNumber }],
      };

    // A stray "yes" with nothing to confirm, and everything unrecognised.
    case "confirm":
    case "reject":
      return { replies: [VOICE.nothingPending], next: "idle", context: ctx, effects: [] };

    default:
      return { replies: [VOICE.outOfScope], next: "idle", context: ctx, effects: [] };
  }
}

/** Turns a parse into a document under construction, then asks or drafts. */
function startDocument(p: Parsed, ctx: Context, now: Civil): Step {
  const doc: PendingDoc = {
    type:
      p.intent === "create_quote"
        ? "quote"
        : p.intent === "payment_request"
          ? "payment_request"
          : "invoice",
    clientName: p.clientName ?? undefined,
    clientEmail: p.clientEmail,
    lines: p.lineItems,
    totalKobo: p.lineItems.length ? undefined : (p.totalKobo ?? undefined),
    dueDate: p.dueDate,
    vatPercent: p.options.vatPercent,
    depositPercent: p.options.depositPercent,
    instalments: p.options.depositPercent == null ? p.options.instalments : null,
    passFeesToClient: p.options.passFeesToClient ?? false,
    notes: p.options.notes,
  };

  // They named a date we could not read. That is worth one question, because
  // they did say something and quietly defaulting would ignore them.
  const unreadableDate = Boolean(p.dueDatePhrase) && !p.dueDate;
  return buildOrAsk(doc, ctx, now, unreadableDate);
}

/**
 * Either shows a draft, or asks for the one thing standing in the way.
 *
 * F6 sets the bar at a client name and an amount. A description defaults to
 * "Services" and a due date defaults to seven days, so neither is worth a
 * round trip — asking for something we already have an answer for is how a
 * two-message flow becomes a five-message one.
 */
function buildOrAsk(doc: PendingDoc, ctx: Context, now: Civil, askDate = false): Step {
  const context = { ...ctx, doc, attempts: 0 };

  /*
   * Nothing at all: send the form.
   *
   * Asking "who is this for?" and then "how much?" is two messages to collect
   * two facts. The form collects both, and everything else, in one.
   */
  if (!doc.clientName && !totalOf(doc) && !doc.lines.length) {
    const template =
      doc.type === "quote"
        ? VOICE.quoteForm
        : doc.type === "payment_request"
          ? VOICE.requestForm
          : VOICE.invoiceForm;

    /*
     * An invoice with nothing in it is the one place a form beats a sentence.
     *
     * Everywhere else the sentence has already said something and the machine
     * only needs the rest. Here there is nothing to build on, and the choice
     * is between four questions and one form.
     *
     * Quotes and payment requests keep the typed template. They are rarer,
     * they carry fewer terms, and each published Flow is a thing to keep
     * working — this one has to earn its place before there are three.
     *
     * The state still moves to `awaiting_field:client_name`, because a form
     * on the screen does not stop somebody typing the answer underneath it,
     * and they should not have to open it.
     */
    if (doc.type === "invoice") {
      return {
        replies: [],
        next: "awaiting_field:client_name",
        context,
        effects: [
          {
            type: "send_flow",
            key: "invoice",
            body: VOICE.invoiceFormBody,
            cta: "Fill in the invoice",
            fallback: { line: template, holdAt: "awaiting_field:client_name" },
          },
        ],
      };
    }

    return {
      replies: [template],
      next: "awaiting_field:client_name",
      context,
      effects: [],
    };
  }

  if (!doc.clientName) {
    return {
      replies: [askFor("client_name", {})],
      next: "awaiting_field:client_name",
      context,
      effects: [],
    };
  }

  if (!totalOf(doc)) {
    return {
      replies: [askFor("amount", { clientName: doc.clientName })],
      next: "awaiting_field:amount",
      context,
      effects: [],
    };
  }

  if (askDate) {
    return { replies: [askFor("due_date", {})], next: "awaiting_field:due_date", context, effects: [] };
  }

  // Everything else has a default, so this is a draft.
  const ready = withDefaults(doc, now);
  return {
    replies: [],
    next: "awaiting_confirm",
    context: { ...ctx, doc: ready, attempts: 0 },
    effects: [{ type: "save_draft", doc: ready }],
  };
}

/** F6: description defaults to "Services", due date to seven days from issue. */
function withDefaults(doc: PendingDoc, now: Civil): PendingDoc {
  // F8: a payment request has no itemised work. "Payment" is what it is.
  const fallback = doc.type === "payment_request" ? "Payment" : DEFAULT_DESCRIPTION;
  const lines = doc.lines.length
    ? doc.lines
    : [{ description: fallback, qty: 1, unitAmountKobo: doc.totalKobo ?? 0 }];

  // An invoice falls due; a quote expires. Different words, different columns
  // and different defaults, but one date on the document either way.
  const days =
    doc.type === "quote"
      ? defaults.behaviour.quoteValidDays
      : defaults.behaviour.defaultDueDays;

  return {
    ...doc,
    lines,
    totalKobo: undefined,
    dueDate: doc.dueDate ?? addDaysTo(now, days),
  };
}

/**
 * A draft, as the invoice form's starting values.
 *
 * Names match the Flow's `data` keys exactly; anything misspelled here is a
 * field that silently opens blank. The amount is naira and a number, because
 * that is what the WORK screen declares and what its input expects.
 *
 * The date goes across as words rather than a calendar value: the field takes
 * words, and the same reader handles "8 October 2026" as handles "Friday".
 */
function formValues(doc: PendingDoc): Record<string, string | number | boolean> {
  return {
    client_name: doc.clientName ?? "",
    client_email: doc.clientEmail ?? "",
    description: doc.lines[0]?.description ?? "",
    amount: Math.round(totalOf(doc) / 100),
    due_date: doc.dueDate ? formatLongDate(doc.dueDate) : "",
    plan: planIdFor({ depositPercent: doc.depositPercent, instalments: doc.instalments }),
    notes: doc.notes ?? "",
    vat: doc.vatPercent != null,
    pass_fees: doc.passFeesToClient === true,
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "8 October 2026" — readable in a form, and readable back by the parser. */
const formatLongDate = (c: Civil): string => `${c.d} ${MONTHS[c.m - 1]} ${c.y}`;

const totalOf = (doc: PendingDoc): number =>
  doc.lines.length
    ? doc.lines.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0)
    : (doc.totalKobo ?? 0);

/** Kept local rather than imported, so the machine stays free of side effects. */
function addDaysTo(c: Civil, days: number): Civil {
  const at = new Date(Date.UTC(c.y, c.m - 1, c.d) + days * 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/* -------------------------------------------------------------------------- */

/** The answer to a single question, and nothing else. */
function takeMissingField(state: State, text: string, ctx: Context, msg: Inbound): Step {
  const doc = ctx.doc;
  if (!doc) return { replies: [VOICE.nothingPending], next: "idle", context: {}, effects: [] };

  const now = today(msg);

  // Section 5: a new command always wins over a pending question.
  const escape = commandEscape(msg, ctx, now);
  if (escape) return escape;

  /*
   * Asking for a different document starts a different document.
   *
   * `commandEscape` deliberately leaves the document intents out, because
   * "Invoice Tunde 20k" arriving mid-flow is usually an answer. But "/invoice"
   * on its own, while a quote is half-built, is nobody's answer to "who is
   * this for?" — it is somebody starting again. It used to be taken as the
   * client's name, and the next question was "How much is /invoice paying?".
   *
   * Only an exact command counts. A model that reads "Zenith Homes" as
   * create_invoice is naming a client, not asking for a new document, and
   * restarting on that would throw away the answer somebody just gave.
   */
  if (msg.parsed && isDocumentIntent(msg.parsed.intent) && msg.parsed.source === "command") {
    return startDocument(msg.parsed, forget(ctx), now);
  }

  const answer = text.trim();

  switch (state) {
    case "awaiting_field:client_name": {
      // The form comes back filled in, or as a plain name. A parse arrives
      // when the caller recognised the first; otherwise it is the second.
      if (msg.parsed && isDocumentIntent(msg.parsed.intent) && msg.parsed.clientName) {
        return startDocument(msg.parsed, ctx, now);
      }

      const name = answer.replace(/^(?:for|to)\s+/i, "").replace(/\s+/g, " ").trim();
      // A slash command is never a client's name. Anything we do not
      // recognise still reaches here, and putting "/whatever" on an invoice
      // is worse than asking once more.
      if (
        name.startsWith("/") ||
        name.length < 2 ||
        name.length > 80 ||
        name.split(" ").length > 6
      ) {
        return retry("awaiting_field:client_name", ctx, askFor("client_name", {}));
      }
      return buildOrAsk({ ...doc, clientName: titleCaseName(name) }, ctx, now);
    }

    case "awaiting_field:amount": {
      const kobo = parseAmountToKobo(answer);
      if (kobo === null || kobo <= 0) {
        return retry("awaiting_field:amount", ctx, askFor("amount", { clientName: doc.clientName }));
      }
      // It attaches to the single line if there is one, so "20k" after
      // "invoice Tunde for a logo" prices the logo rather than adding a line.
      const lines =
        doc.lines.length === 1
          ? [{ ...doc.lines[0]!, unitAmountKobo: kobo, qty: 1 }]
          : doc.lines;
      return buildOrAsk(
        { ...doc, lines, totalKobo: lines.length ? undefined : kobo },
        ctx,
        now,
      );
    }

    case "awaiting_field:description": {
      if (/^(skip|nothing|none|no)$/i.test(answer)) return buildOrAsk(doc, ctx, now);
      const description = answer.slice(0, 200).trim();
      if (!description) return retry("awaiting_field:description", ctx, askFor("description", {}));
      const total = totalOf(doc);
      return buildOrAsk(
        { ...doc, lines: [{ description, qty: 1, unitAmountKobo: total }], totalKobo: undefined },
        ctx,
        now,
      );
    }

    case "awaiting_field:due_date": {
      if (/^(skip|none|no|default|whenever)$/i.test(answer)) {
        return buildOrAsk({ ...doc, dueDate: null }, ctx, now);
      }
      const resolved = resolveDueDate(answer, now);
      if (!resolved) return retry("awaiting_field:due_date", ctx, askFor("due_date", {}));
      return buildOrAsk({ ...doc, dueDate: resolved.date }, ctx, now);
    }

    default:
      return { replies: [VOICE.nothingPending], next: "idle", context: {}, effects: [] };
  }
}

/* -------------------------------------------------------------------------- */

/** The draft is on screen. Confirm, reject, correct, or change the subject. */
function atConfirm(text: string, ctx: Context, msg: Inbound): Step {
  const doc = ctx.doc;
  if (!doc || !ctx.draftId) {
    return { replies: [VOICE.nothingPending], next: "idle", context: {}, effects: [] };
  }

  const now = today(msg);
  const intent = msg.parsed?.intent;

  if (intent === "confirm") {
    return {
      replies: [],
      next: "idle",
      // The draft id stays until the effect has used it.
      context: { ...ctx, attempts: 0 },
      effects: [{ type: "send_document" }],
    };
  }

  if (intent === "reject") {
    return {
      replies: [VOICE.draftDiscarded],
      next: "idle",
      context: forget(ctx),
      effects: [{ type: "discard_draft" }],
    };
  }

  /* A correction: change it and show it again (F6 step 3). ----------------- */
  if (msg.correction) {
    return buildOrAsk(applyCorrection(doc, msg.correction), ctx, now);
  }

  /*
   * The "Change it" button, which says what they want to do without saying
   * what to change. Matched on the exact button id rather than loosely, so a
   * typed sentence that happens to contain the word "change" still goes to the
   * correction parser where it belongs.
   */
  if (/^change something$/i.test(text.trim())) {
    /*
     * The form, opened on what is already there.
     *
     * Typing the change is still the faster road for "make it 400k", and it
     * still works — the state stays on the draft, so a typed correction lands
     * exactly as it did before. What the form adds is everything that is
     * awkward to say: swapping the payment plan, adding VAT, fixing three
     * things at once without three round trips.
     *
     * Every field goes across, including the two on the second screen. A value
     * that is not carried is a value an edit quietly clears, and somebody who
     * loses their VAT setting by opening a form to fix a client name will not
     * work out why.
     */
    return {
      replies: [],
      next: "awaiting_confirm",
      context: { ...ctx, attempts: 0 },
      effects: [
        {
          type: "send_flow",
          key: "invoice",
          body: VOICE.changeInvite,
          cta: "Change the invoice",
          data: formValues(doc),
          fallback: { line: VOICE.changeByHand, holdAt: "awaiting_confirm" },
        },
      ],
    };
  }

  /* A whole new document replaces this one. -------------------------------- */
  if (
    msg.parsed &&
    (intent === "create_invoice" || intent === "create_quote" || intent === "payment_request")
  ) {
    return startDocument(msg.parsed, forget(ctx), now);
  }

  const escape = commandEscape(msg, ctx, now);
  if (escape) return escape;

  return retry(
    "awaiting_confirm",
    ctx,
    lines(
      `🤔 I did not catch that. Tap a button above, or tell me what to change —`,
      `something like ${b("make it 400k")} or ${b("due next Friday")}.`,
    ),
  );
}

function applyCorrection(doc: PendingDoc, c: Correction): PendingDoc {
  const next: PendingDoc = { ...doc };

  if (c.clientName) next.clientName = c.clientName;
  if (c.dueDate) next.dueDate = c.dueDate;
  if (c.vatPercent !== undefined) next.vatPercent = c.vatPercent;
  if (c.depositPercent !== undefined) next.depositPercent = c.depositPercent;
  if (c.instalments !== undefined) next.instalments = c.instalments;
  if (c.passFeesToClient !== undefined) next.passFeesToClient = c.passFeesToClient;

  if (c.description) {
    next.lines = next.lines.length
      ? [{ ...next.lines[0]!, description: c.description }, ...next.lines.slice(1)]
      : [{ description: c.description, qty: 1, unitAmountKobo: next.totalKobo ?? 0 }];
    next.totalKobo = undefined;
  }

  if (c.totalKobo !== undefined) {
    // A new total replaces the price of a single line. With several lines
    // there is no honest way to spread it, so it becomes one line instead and
    // the summary shows exactly that.
    next.lines = next.lines.length
      ? [{ ...next.lines[0]!, qty: 1, unitAmountKobo: c.totalKobo }]
      : [];
    next.totalKobo = next.lines.length ? undefined : c.totalKobo;
  }

  return next;
}

/**
 * Section 5: "A new command always wins over a pending question, so users are
 * never trapped." Anything that is plainly a different instruction abandons
 * the draft and runs.
 */
function commandEscape(msg: Inbound, ctx: Context, now: Civil): Step | null {
  const intent = msg.parsed?.intent;
  if (!intent || !msg.parsed) return null;

  // Everything the slash menu offers that only navigates. `templates` was
  // missing, which meant /design could not get out of any pending question —
  // it was answered as if it were the answer, over and over.
  const leaves = ["debtors", "summary", "settings", "templates", "upgrade", "referral", "status",
                  "stop_reminders", "cancel_document", "resend_document", "convert_quote"];
  if (!leaves.includes(intent)) return null;

  const step = fromParsed(msg, forget(ctx), now);
  return { ...step, effects: [{ type: "discard_draft" }, ...step.effects] };
}

/** The two answers to the Pro offer (F18). Fixed phrases, not a model call. */
function asProChoice(text: string): "link" | "deduct_from_invoice" | null {
  const s = text.toLowerCase().trim().replace(/[.!]+$/, "");
  if (/^(pay now|pay link|payment link|send me the link|card|pay by card)$/.test(s)) return "link";
  if (/^(from my invoices?|deduct|deduct from invoices?|take it from my invoices?|take from invoice|from invoice)$/.test(s)) {
    return "deduct_from_invoice";
  }
  return null;
}

/** Clears the document out of the conversation, keeping the account details. */
/**
 * Drops whatever the conversation was in the middle of.
 *
 * `changing` goes with the draft. It holds a resolved account name and a
 * subaccount code for a bank change that was never confirmed, and leaving it
 * lying in the conversation means carrying somebody's account details around
 * for as long as they keep chatting. The effect that commits a change reads
 * the *previous* turn's context, so clearing it here cannot strand one.
 */
const forget = (ctx: Context): Context => {
  const { doc: _doc, draftId: _draftId, changing: _changing, ...rest } = ctx;
  return rest;
};

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Things that are certainly not a business name.
 *
 * Deliberately mechanical, and deliberately short. The temptation is to ask a
 * model whether something "looks like" a business name, and that trades a bug
 * you can reason about for one you cannot: it would refuse "Xo", "MOTX",
 * "9ja Prints", or any Yoruba, Igbo or Hausa name it has not seen, and the
 * person on the other end has no way to argue with it. In Nigeria that is
 * exactly where a model is weakest.
 *
 * The asymmetry decides it. A wrong name that got through is fixed in
 * /settings in ten seconds. A right name that was refused is somebody who
 * cannot finish signing up.
 *
 * So only what cannot be anybody's name, and each one says which it was —
 * "that looks like an email address" tells somebody what to do next, where
 * "that does not look like a business name" tells them nothing.
 *
 * Note what is absent: a rule about digits. "9ja Prints", "247 Logistics" and
 * "Studio 54" are all real, and the letters rule already catches a bare phone
 * number, because a phone number has none.
 */
const NOT_A_NAME: { test: RegExp; why: string }[] = [
  { test: /^\S+@\S+\.\S+$/, why: "That looks like an email address." },
  { test: /^(?:https?:\/\/|www\.)/i, why: "That looks like a web address." },
  // Last, so the two above get to name themselves first.
  { test: /^\P{L}+$/u, why: "A name needs at least one letter in it." },
];

function takeBusinessName(text: string, ctx: Context, msg: Inbound): Step {
  const name = text.replace(/\s+/g, " ").trim();

  // A slash command is never a business name. `step` refuses these before
  // they reach here; this is the field that was actually corrupted by one, so
  // it does not take that on trust.
  const wrong =
    name.length < 2 || name.length > 80 || name.startsWith("/")
      ? "That does not look like a business name."
      : NOT_A_NAME.find((r) => r.test.test(name))?.why;

  if (wrong) {
    return retry(
      "onboarding:business_name",
      ctx,
      lines(
        wrong,
        `Send the name your clients would recognise — like ${b("Kemi Adeyemi Studio")}.`,
      ),
    );
  }

  return {
    replies: [VOICE.gotNameAskBank(name)],
    next: "onboarding:bank",
    context: { ...ctx, businessName: titleCaseName(name), attempts: 0 },
    effects: [],
  };
}

/**
 * Accepts "GTBank 0123456789" in any order, and copes with the number being
 * sent on its own line.
 */
function takeBank(text: string, ctx: Context): Step {
  const account = text.match(/\b(\d{10})\b/)?.[1];
  const bank = text.replace(/\b\d{10}\b/, "").replace(/\s+/g, " ").trim();

  if (!account) {
    return retry(
      "onboarding:bank",
      ctx,
      lines(
        "I need a 10-digit account number.",
        `Send the bank and the number together — like ${b("GTBank 0123456789")}.`,
      ),
    );
  }
  if (bank.length < 2) {
    return retry(
      "onboarding:bank",
      ctx,
      `Which bank is ${b(account)} with? Send the bank name, like ${b("GTBank")}.`,
    );
  }

  return {
    replies: [],
    next: "onboarding:confirm_account",
    context: { ...ctx, accountNumber: account, bankName: bank, attempts: 0 },
    // The caller resolves the name with the provider. We never take the user's
    // word for whose account it is (F17).
    effects: [
      { type: "resolve_account", bankQuery: bank, accountNumber: account, haveEmail: Boolean(ctx.email) },
    ],
  };
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function confirmAccount(text: string, ctx: Context): Step {
  // Confirming and giving the email are one turn, not two. The question asks
  // for the address, so an address *is* the yes — which removes a round trip
  // and the message that went with it. Someone who just says "yes" is still
  // right, and gets asked for the address on its own.
  const email = text.trim().toLowerCase();
  if (EMAIL.test(email) && email.length <= 254) {
    return {
      replies: [VOICE.askCode(email)],
      buttons: VOICE.codeButtons(),
      next: "onboarding:verify_email",
      context: { ...ctx, email, attempts: 0 },
      effects: [{ type: "create_subaccount" }, { type: "send_email_code", email }],
    };
  }

  if (/^(yes|yeah|yep|correct|that is right|na me|ok|okay)\b/i.test(text)) {
    // The form already gave us one. Asking again for something somebody has
    // typed once is the single most irritating thing software does, and it
    // reads as though nothing they did was saved.
    if (ctx.email) {
      return {
        replies: [VOICE.askCode(ctx.email)],
        buttons: VOICE.codeButtons(),
        next: "onboarding:verify_email",
        context: { ...ctx, attempts: 0 },
        effects: [{ type: "create_subaccount" }, { type: "send_email_code", email: ctx.email }],
      };
    }
    return {
      replies: [VOICE.askEmail],
      next: "onboarding:email",
      context: { ...ctx, attempts: 0 },
      effects: [{ type: "create_subaccount" }],
    };
  }
  if (/^(no|nope|wrong|not me|that is wrong)\b/i.test(text)) {
    return {
      replies: [VOICE.askBank],
      next: "onboarding:bank",
      context: { ...ctx, accountNumber: undefined, bankName: undefined, resolvedAccountName: undefined },
      effects: [],
    };
  }
  const confirm = ctx.email
    ? `Reply ${b("yes")} if it is, or ${b("no")} to send different details.`
    : `Send your email address if it is, or reply ${b("no")}.`;

  return retry(
    "onboarding:confirm_account",
    ctx,
    ctx.resolvedAccountName
      ? lines(`Is ${b(ctx.resolvedAccountName)} the right account?`, confirm)
      : confirm,
  );
}

function takeEmail(text: string, ctx: Context): Step {
  const email = text.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    return retry(
      "onboarding:email",
      ctx,
      lines(
        "That does not look like an email address.",
        `Send it like ${b("you@yourbusiness.com")}.`,
      ),
    );
  }
  return {
    replies: [VOICE.askCode(email)],
    buttons: VOICE.codeButtons(),
    next: "onboarding:verify_email",
    context: { ...ctx, email, attempts: 0 },
    effects: [{ type: "send_email_code", email }],
  };
}

function takeCode(text: string, ctx: Context): Step {
  const trimmed = text.trim();

  // "resend" is a way out of a code that never arrived, which is otherwise a
  // dead end: the person cannot proceed and cannot ask for another.
  if (/^(resend|send again|didn.?t get it|no code)\b/i.test(trimmed)) {
    return {
      // The effect says nothing when it works, so without this a "resend"
      // answers with silence — exactly what the person was complaining about.
      replies: [VOICE.askCode(ctx.email ?? "")],
      buttons: VOICE.codeButtons(),
      next: "onboarding:verify_email",
      context: { ...ctx, attempts: 0 },
      effects: [{ type: "send_email_code", email: ctx.email ?? "" }],
    };
  }

  // Changing the address mid-step, for the common case of a typo.
  if (/^(change|wrong email|different email)\b/i.test(trimmed)) {
    return {
      replies: [VOICE.askEmail],
      next: "onboarding:email",
      context: { ...ctx, email: undefined, attempts: 0 },
      effects: [],
    };
  }

  const code = trimmed.replace(/\D/g, "");
  if (code.length !== 6) {
    return retry(
      "onboarding:verify_email",
      ctx,
      `The code is ${b("6 digits")}. Send it, or reply ${b("resend")} for a new one.`,
    );
  }

  // Whether it is right is the caller's business: only it can check the hash.
  // It moves the conversation on, or holds it here, and it owns what is said
  // either way — which is why there are no replies here.
  return {
    replies: [],
    next: "onboarding:consent",
    context: { ...ctx, attempts: 0 },
    effects: [{ type: "verify_email_code", email: ctx.email ?? "", code }],
  };
}

function takeConsent(text: string, ctx: Context, version: string): Step {
  if (/\b(i agree|agree|agreed|yes|accept|i accept)\b/i.test(text)) {
    return {
      // The card and the button are one message, so a reply here would be a
      // second bubble saying the same thing.
      replies: [],
      next: "idle",
      context: { ...ctx, attempts: 0 },
      effects: [
        { type: "record_consent", version },
        {
          type: "send_flow",
          key: "invoice",
          body: VOICE.doneCaption,
          cta: "Create invoice",
          image: SETUP_DONE_CARD,
          // Without a published form there is no card either, so the fallback
          // has to carry the example the card was showing.
          fallback: { line: VOICE.done, holdAt: "idle" },
        },
      ],
    };
  }
  return {
    ...retry(
      "onboarding:consent",
      ctx,
      lines(
        "📄 I need your agreement before we can create documents.",
        "Any question first, email hello@balans.ng.",
      ),
    ),
    buttons: VOICE.consentButtons(),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Repeats a question, and offers a way out after three wrong answers.
 *
 * Without this someone who cannot answer is stuck in a loop with no exit,
 * which is the single worst thing a chat flow can do to a person.
 */
function retry(state: State, ctx: Context, message: string): Step {
  const attempts = (ctx.attempts ?? 0) + 1;
  const replies = [message];
  if (attempts >= 3) {
    replies.push(
      `If this is not working, email ${b("hello@balans.ng")} and a person will set it up with you.`,
    );
  }
  return { replies, next: state, context: { ...ctx, attempts }, effects: [] };
}

function onboardingHelp(state: State): string {
  switch (state) {
    case "onboarding:business_name":
      return lines(
        "I am setting up your account.",
        `Send the name your clients would recognise — like ${b("Kemi Adeyemi Studio")}.`,
        `Reply ${b("cancel")} to start again.`,
      );
    case "onboarding:bank":
      return lines(
        `Send your bank and account number together — like ${b("GTBank 0123456789")}.`,
        "This is where your money will settle.",
        `Reply ${b("cancel")} to start again.`,
      );
    case "onboarding:confirm_account":
      return lines(
        "If that is your account, send your email address.",
        `If it is not, reply ${b("no")} and send different details.`,
      );
    case "onboarding:email":
      return `Send an email address you can open now — ${b("we will send a code to it")}.`;
    case "onboarding:verify_email":
      return lines(
        `Send the ${b("6-digit code")} from your email.`,
        `Reply ${b("resend")} for another, or ${b("cancel")} to start again.`,
      );
    case "onboarding:consent":
      return lines(
        `Read ${TERMS_URL} and ${PRIVACY_URL},`,
        `then reply ${b("I agree")}.`,
      );
    default:
      return VOICE.helpIdle;
  }
}

/** Exported for the onboarding tests and the eventual bank-change flow (F17). */
export const _internal = { normalisePhone };
