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
import { b, BULLET, field, i, lines, para } from "../whatsapp/format.ts";
import type { Civil } from "../../core/dates.ts";
import { isDocumentIntent, type Parsed } from "../parser/schema.ts";
import type { Correction } from "../parser/corrections.ts";
import { shapeFor } from "../documents/parts.ts";
import { asCommand, faqKind, socialKind, type FaqKind, type SocialKind } from "../parser/commands.ts";
import { SETTINGS_ROW_IDS } from "../settings/messages.ts";

type SettingsRowId = (typeof SETTINGS_ROW_IDS)[number];
import {
  MAX_INVOICE_KOBO,
  MIN_INVOICE_KOBO,
  parseAmountToKobo,
} from "../../core/amount.ts";
import { formatNaira } from "../../core/totals.ts";
import { resolveDueDate } from "../../core/dates.ts";
import { titleCaseName } from "../../core/names.ts";
import { EXTRA_ITEMS, formScreenId, itemFields, planIdFor } from "../whatsapp/flows/definitions.ts";
import { askFor, DEFAULT_DESCRIPTION, draftButtons } from "../documents/summary.ts";
import { defaults, env } from "../config.ts";
import { INFO, type Foreign } from "../../core/currency.ts";
import { nairaKoboFor } from "../../core/exchange.ts";
import type { Quote } from "../fx/rate.ts";

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
  /** A picture arrived and we have asked whether it is their logo. */
  | "awaiting_logo_confirm"
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
   * The instruction somebody opened with, kept until setup is done.
   *
   * "Invoice Tunde 20k for logo design, due Friday" is one of the four
   * suggestions WhatsApp shows above an empty chat, so it is a likely first
   * message from somebody with no account. The reply to it — "let us get you
   * set up first, then I can do that" — was a promise nothing kept: the text
   * was dropped on the floor and setup ended with a generic card.
   *
   * So it is carried through the whole of onboarding and replayed at the end
   * as if they had just typed it. That is their first draft, four minutes
   * after their first message, without having to say it twice.
   *
   * Only a real instruction is kept. A greeting, a question and a request for
   * help are answered where they are asked and never replayed.
   */
  opener?: string;

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

  /**
   * A picture we have been sent and not yet done anything with.
   *
   * Held while we ask whether it is a logo. The id is Meta's and stays
   * downloadable for long enough that fetching it on the answer rather than
   * on arrival costs nothing — and saves fetching every screenshot somebody
   * sends.
   */
  pendingLogo?: string;
};

/** A document under construction. Amounts are kobo; nothing here is a string. */
export type PendingDoc = {
  type: "invoice" | "quote" | "payment_request";
  clientName?: string;
  clientEmail?: string | null;
  /**
   * The client's WhatsApp number, international digits ("2348031234567").
   * With one, the document goes to them from Balans when it is sent.
   */
  clientPhone?: string | null;
  /**
   * The work, priced in kobo — always, including on an invoice agreed in
   * dollars. `originalUnitAmountMinor` is what was agreed, kept beside it for
   * the client's copy, which shows "$200" against the logo because $200 is
   * what they said yes to.
   */
  lines: {
    description: string;
    qty: number;
    unitAmountKobo: number;
    originalUnitAmountMinor?: number;
  }[];
  /** Set when an amount arrived with no description to attach it to. */
  totalKobo?: number;
  /**
   * The foreign price and the rate it was converted at (International PRD
   * section 6), or absent on the naira invoices that are nearly all of them.
   *
   * Present from the moment the draft is made, because the rate is locked at
   * creation and never moves again: the client is charged naira, and an
   * invoice whose naira figure changed between being sent and being paid is
   * not an invoice. The only thing that re-quotes is an edit to the amount,
   * which is a different invoice.
   *
   * `fetchedAt` is an ISO string rather than a Date because a draft is JSON
   * in the conversation row until somebody answers "Send it?".
   */
  foreign?: {
    currency: Foreign;
    /** What was agreed, in cents or pence. The figure on the invoice. */
    amountMinor: number;
    rate: number;
    source: string;
    fetchedAt: string;
  };
  dueDate?: Civil | null;
  vatPercent?: number | null;
  depositPercent?: number | null;
  /** Equal payments. Never set alongside `depositPercent`; see `shapeFor`. */
  instalments?: number | null;
  /**
   * Dates set for particular parts of the plan, by position.
   *
   * Sparse. The schedule spaces the parts it has not been told about, which
   * is nearly always the right answer — but "let the 50% deposit be due on
   * Friday" is not a guess anybody should override, and there was previously
   * nowhere to put it.
   */
  stageDueDates?: (Civil | null)[] | null;
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
      key: "onboarding" | "business_details" | "invoice" | "quote" | "request" | "consent";
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
       * Which screen the form opens on.
       *
       * The document forms have one screen per number of items — WORK_ONE
       * through WORK_FIVE — so a three-line draft has to open on the screen
       * with three sets of boxes. Left unset, the caller uses the Flow's
       * usual first screen, which is what every other form wants.
       */
      screen?: string;
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
  /** The link to the signature page. */
  | { type: "show_signature" }
  | { type: "remove_signature" }
  | { type: "show_upgrade" }
  | { type: "show_referral" }
  /** A picture they have confirmed is their logo. */
  | { type: "save_logo"; mediaId: string }
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
  /**
   * True when this came from tapping a button or a list row.
   *
   * A row id arrives as ordinary text, so the machine could not tell the
   * difference — and while the conversation was waiting for a typed answer,
   * a tapped row became the answer. Somebody tapped "Close my account" while
   * being asked for a new business name, and their business was renamed
   * "Delete My Account".
   */
  tapped?: boolean;
  /** Today in Lagos, for the default due date. */
  today?: Civil;
  /**
   * A naira rate, fetched by the caller when the message was priced abroad.
   *
   * Fetching is I/O and this function is not, so the rate is looked up at the
   * edge exactly as the parse is, and the decision happens here. Absent means
   * either that the message was in naira, or that no rate could be had — and
   * the second is not this function's problem to explain, because the caller
   * already knows the difference and has words for it.
   */
  quote?: Quote;
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
export const SETUP_DONE_CARD = brand("setup-done.png");
export const LIMIT_CARD = brand("limit.png");
export const UPGRADE_CARD = brand("upgrade.png");
export const PRO_CARD = brand("pro.png");
const TERMS_URL = site + "/terms";
const PRIVACY_URL = site + "/privacy";

/*
 * These match the whole message, not the start of it.
 *
 * They were prefix matches with a word boundary, which reads fine until
 * somebody's business is called Stop Motion Studios. "Stop" at the front
 * matched, setup restarted, and there was no name that person could type to
 * get past it — every attempt began with the word that threw the attempt
 * away. Cancel Culture Media and Help Desk Nigeria are the same trap, and
 * Hi-Tech Solutions hit it on the greeting.
 *
 * Trailing punctuation still counts, because "help!" is help. A greeting
 * keeps the words people attach to one. Anything longer is a sentence, and a
 * sentence opening with "stop" is far more likely to be a name than an
 * instruction: the instruction is one word and people send it on its own.
 */
const HELP = /^(help|menu|what can you do|abeg help)[.!?]*$/i;
const CANCEL = /^(cancel|stop|start over|restart)[.!?]*$/i;
/**
 * The part of a line's name that tells it apart from the others.
 *
 * For the example in `whichItem`, which has to be an instruction that would
 * actually work. Three lines called "Sole Capsule Website UI", "Sole Capsule
 * Website Development" and "Sole Capsule SEO" share their first two words,
 * so "change the Sole Capsule to 400k" names all three — it is exactly the
 * ambiguity being complained about, handed back as the fix for it.
 *
 * So the words every line begins with are dropped first, and what is left is
 * what distinguishes this one. Two words of it, because a full description
 * makes an example nobody reads to the end.
 */
function tellApart(all: { description: string }[], pick = 0): string {
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
  const mine = words(all[pick]?.description ?? "");
  if (!mine.length) return "item";

  const others = all.filter((_, i) => i !== pick).map((l) => words(l.description));

  let shared = 0;
  while (
    shared < mine.length - 1 &&
    others.length > 0 &&
    others.every((o) => (o[shared] ?? "").toLowerCase() === mine[shared]!.toLowerCase())
  ) {
    shared += 1;
  }

  return mine.slice(shared, shared + 2).join(" ");
}

const GREETING =
  /^(hi|hello|hey|good (morning|afternoon|evening)|hola|howfa|how far)( there| sir| ma| boss| o)?[.!?]*$/i;

/**
 * "Set me up", the first of the four suggestions above an empty chat.
 *
 * An emoji is allowed on the front although the suggestion no longer carries
 * one — Meta replaces emoji in ice breakers with U+FFFD, so ours is plain
 * text. People type them anyway, and a leading wave must not stop this
 * matching: at `onboarding:form` anything that is not a greeting is taken as
 * a business name, so the account would come out called "👋 Set me up".
 */
const SETUP_ME =
  /^(?:\p{Extended_Pictographic}\uFE0F?\s*)?(?:set (?:me )?up|setup|sign me up|get(?: me)? started|let'?s (?:start|go|do it)|start)[.!]*$/iu;

/**
 * The way out of a wrong client name, under "How much is X paying?".
 *
 * The id is what a tap sends back, so it is also a sentence that works typed.
 */
export const CHANGE_NAME: ReplyButton = { id: "change client name", title: "Change name" };
const CHANGE_NAME_ASK =
  /^(?:change|edit|fix|wrong)(?: the)?(?: client(?:'?s)?)? name[.!]*$|^(?:that'?s|that is) (?:the )?wrong name[.!]*$/i;
/** "change the name to Daniel", "the name is Daniel", "rename it to Daniel", "it's for Daniel". */
const CHANGE_NAME_TO =
  /^(?:(?:please |pls |abeg )?(?:change|update|set|make)(?: the)?(?: client(?:'?s)?)? name(?: to| as)?|(?:the )?(?:client(?:'?s)? )?name (?:is|should be)|rename(?: it| him| her| them)? (?:to|as)|(?:it'?s|it is|this is) for) (.+?)[.!]*$/i;

/** What to do next, under an answer that has the setup button beneath it. */
const SETUP_NUDGE = "Tap below to set up. It takes about a minute.";

/**
 * Everything the bot says during setup.
 *
 * Two things shape the copy. Bold marks values and actions, so a glance finds
 * the thing to check and the thing to do. And a turn is one message: WhatsApp
 * bills Nigeria per service message from 1 October 2026, so a "Got it" on its
 * own line is a real cost for something that reads better joined to the
 * question after it. PRD section 15 puts the whole of setup at six messages.
 */
/**
 * The line under the Amount box on the invoice form.
 *
 * Two of them, because "Naira, before VAT" is right for almost everybody and
 * flatly wrong above a box somebody has just set to dollars. Which one is
 * sent is decided by the same thing that decides whether the currency box is
 * shown at all.
 */
export const NAIRA_HELP = "Naira, before VAT. Digits only.";
export const ABROAD_HELP = "Before VAT, in the currency above. Digits only.";

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

  /**
   * "How does Balans work?", asked by somebody who has not signed up.
   *
   * One of the four suggestions above an empty chat, so this is read by a
   * stranger — which rules out the command menu. A list of ten slash
   * commands answers "what can I type" for somebody who has already decided;
   * this question is asked by somebody who has not, and what they want is
   * the shape of the thing in three lines.
   *
   * Numbered rather than bulleted because it is a sequence, and the order is
   * the whole explanation.
   */
  howItWorks: para(
    `\u{1F4A1} ${b("Three steps, all in this chat.")}`,
    lines(
      `1. Tell me who to bill and what for \u2014 ${i("invoice Tunde 20k for logo design")}.`,
      "2. I write the invoice in your business name and send it to them.",
      "3. They pay straight into your bank account. Tell me when it lands and I send the receipt.",
    ),
  ),

  /**
   * "Is my money safe?"
   *
   * The first question anybody in Nigeria asks about something that touches
   * a bank account, and the people who will not ask it out loud are the ones
   * who quietly leave instead. So it is one of the four things offered above
   * an empty chat, and the answer is the plainest sentence we have.
   *
   * The same words the invoice page and the welcome email use, deliberately.
   * A product that describes where the money goes in three different ways in
   * three different places is a product nobody believes.
   */
  moneySafe: para(
    `\u{1F512} ${b("Your money never passes through us.")}`,
    lines(
      "Your client pays by transfer straight into your own bank account \u2014 the one you give us here.",
      "A client abroad pays by card through Paystack, a licensed payment processor, and it settles to the same account.",
      "Balans is not a bank and never holds your money.",
    ),
  ),

  /* -- Money that is not naira (International PRD sections 5 and 14) ------- */

  /**
   * A foreign price, while international invoicing is switched off.
   *
   * Acceptance criterion 9 asks for "a friendly 'not available yet' reply",
   * and the important word is *reply*. The alternative is not silence — it is
   * "£500" being read as ₦500 and an invoice for a month's work going out
   * priced at the cost of a bottle of water. So this sentence is the whole
   * feature until the rest of it exists, and it is why the currency reader
   * runs whether the flag is on or off.
   */
  notInThatCurrency: (named: string): string =>
    para(
      `\u{1F30D} ${b(`I cannot invoice in ${named} yet.`)}`,
      lines("Naira for now.", "Dollars and pounds are coming soon — I will tell you when."),
    ),

  /**
   * A currency Balans will not take at all.
   *
   * Said by name, because "I did not understand that" would be a lie: it was
   * understood exactly, and refused. Somebody who wrote €500 needs to know
   * that the answer will still be no tomorrow.
   */
  currencyNotTaken: (named: string): string =>
    para(
      `\u{1F30D} ${b(`Balans does not do ${named}.`)}`,
      "Naira only for now, with dollars and pounds on the way.",
    ),

  /**
   * Two currencies in one message.
   *
   * Section 5: "If the message contains both naira and a foreign currency,
   * ask which one." There is no safe way to pick — both readings are
   * defensible and the gap between them is three orders of magnitude — so the
   * only honest move is to ask.
   */
  whichCurrency: (first: string, second: string): string =>
    para(
      `\u{1F30D} ${b("Which one?")} You wrote ${first} and ${second}.`,
      "Tell me which and I will draft it.",
    ),

  /**
   * A dollar invoice from somebody on the free plan.
   *
   * Section 4's words, near enough: "Invoicing in dollars and pounds is a Pro
   * feature. Reply upgrade to unlock it." And no invoice is created — not a
   * draft they cannot send, not a naira one at today's rate. Drafting
   * something and then refusing to send it is worse than refusing now,
   * because by then they have read it and agreed with it.
   */
  foreignIsPro: para(
    `\u{1F30D} ${b("Invoicing in dollars and pounds is a Pro feature.")}`,
    lines("Reply *upgrade* to unlock it.", "Naira invoices work on any plan."),
  ),

  /**
   * The rate could not be had, and so the invoice cannot be priced.
   *
   * Section 6 forbids guessing one. There is no fallback rate and no
   * last-known-good stretched past a day, because an invoice priced at a
   * number nobody can vouch for is worse than no invoice: it goes out, the
   * client pays it, and what arrives is whatever it turns out to be.
   */
  noRateToday: (named: string): string =>
    para(
      `\u{1F30D} ${b(`I cannot get today's ${named} rate just now.`)}`,
      lines("Try again in a few minutes.", "Naira invoices are working normally."),
    ),

  /**
   * Over one of the international ceilings (section 10).
   *
   * Said as what it is — a limit on this, while this is new — rather than
   * dressed up as a problem with their invoice. Somebody billing $3,000 has
   * not done anything wrong, and the naira route is open to them today.
   */
  foreignTooBig: (priced: string, cap: string, daily: boolean): string =>
    para(
      `\u{1F30D} ${b(`${daily ? "That would go over today's limit" : "That is over the limit"} for invoices abroad.`)}`,
      lines(
        daily
          ? `${cap} a day for now, and this one is ${priced}.`
          : `${cap} per invoice for now, and this one is ${priced}.`,
        "International invoicing is new here, so the ceiling is low while we watch it. Naira invoices have no such limit.",
      ),
    ),

  /** They closed the form, or would rather type. Both are fine. */
  setupByHand: para(
    "📝 No problem, we can do it here instead.",
    lines(b("What is your business called?"), "This is the name your clients see on every invoice."),
  ),

  /**
   * The first thing a closed account hears when it writes again.
   *
   * It says the setup is starting over before the setup starts, because the
   * alternative is being asked your own business name by something that
   * clearly knew it last week.
   */
  welcomeBack: para(
    `👋 ${b("Welcome back.")}`,
    lines(
      "Your account was closed, so there is nothing left to pick up — we will set you up again from the start.",
      "Records of money that already moved are still kept, as the law requires.",
    ),
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
    para(`Code sent to ${b(email)}.`, lines(b("Send me the 6 digits code."), "No code?")),

  /** The two ways out of the code step, as taps. */
  codeButtons: (): ReplyButton[] => [
    { id: "resend", title: "Send again" },
    { id: "change", title: "Other email" },
  ],

  /**
   * A way out of a dead end.
   *
   * "There is no draft waiting" is the reply to somebody who tapped a button
   * on an old message, or answered a question that has since been dropped.
   * They are, by definition, somewhere they did not mean to be \u2014 and the
   * message answered them with one example and nothing to tap.
   *
   * The id is the word the parser already reads, so the button and typing
   * "help" take exactly the same path and neither needs a special case.
   */
  helpButton: (): ReplyButton[] => [{ id: "help", title: "Need help?" }],

  /**
   * The same moment, carried by the consent Flow.
   *
   * No links in the body, because the Flow already has both of them as taps
   * on the screen this message opens — and two bare URLs above a button that
   * leads to the same two documents is the reader doing the work of deciding
   * which copy to trust. The message says what is coming; the screen holds
   * the summary and the documents.
   */
  consentFormBody: para(
    "✅ Email confirmed.",
    "One last thing — our terms and privacy notice.",
    b("Agree to finish?"),
  ),

  /**
   * The same thing in words, for when there is no Flow to open.
   *
   * Here the links have to be in the message: until the business is verified
   * Meta will not publish a Flow, and somebody in that window still has to be
   * able to read what they are agreeing to before they agree to it.
   */
  confirmedAskConsent: para(
    "✅ Email confirmed.",
    lines("One last thing — our terms and privacy notice:", TERMS_URL, PRIVACY_URL),
    b("Agree to finish?"),
  ),

  /*
   * One button, not two. There is no "decline" that leads anywhere — refusing
   * the terms means no account — so offering it would be a door into a room
   * that does not exist. Somebody who does not agree simply stops.
   */
  consentButtons: (): ReplyButton[] => [{ id: "I agree", title: "I agree" }],

  /**
   * Yes and no, wherever a question has exactly those two answers.
   *
   * No emoji on either. A button is already unmistakably a button — WhatsApp
   * draws it as one — so a tick in front of the word decorates something that
   * was never ambiguous, and three of them in a row is noise.
   *
   * The exception is "That's me" / "Not me", on the account-name check. That
   * is the one question in the product where tapping the wrong button sends
   * somebody's money to the wrong bank account, and the tick and cross are
   * doing work there: they separate the two answers at a glance, for someone
   * reading quickly.
   */
  yesNo: (yes = "Yes", no = "No"): ReplyButton[] => [
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

  /**
   * Set up, for somebody who asked for something before any of this started.
   *
   * No example and no button: the next message is their own first draft,
   * built from the sentence they opened with. Showing them how to ask for an
   * invoice immediately before answering the one they already asked for
   * would be the bot talking over itself.
   */
  doneNowThat: para(
    `\u{1F389} ${b("You are set up.")}`,
    "Now, the one you asked for.",
  ),

  /**
   * A price, on a draft with several lines, with no word for which one.
   *
   * The list is the whole of the answer: somebody who has just been asked
   * "which item?" needs to see the items. Their own words are offered back
   * with the first one's name in them, because the shape of the instruction
   * is the thing being taught, and a made-up example teaches it worse.
   */
  whichItem: (doc: PendingDoc, kobo: number): string =>
    para(
      `\u{1F914} ${b(`Which one should be ${formatNaira(kobo)}?`)}`,
      lines(
        `There are ${doc.lines.length} on this ${doc.type === "quote" ? "quote" : "invoice"}:`,
        ...doc.lines.map((l) => `${BULLET}${l.description}`),
      ),
      lines(
        `Name it — like ${i(`change the ${tellApart(doc.lines)} to ${formatNaira(kobo)}`)}.`,
        `Or ${i(`change the total to ${formatNaira(kobo)}`)} to replace them all with one line.`,
      ),
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

  /**
   * A draft with more lines on it than the form can show.
   *
   * It says why, because "use words instead" with no reason reads like the
   * form is broken. The form holds five; this draft has more.
   */
  tooManyLinesToForm: lines(
    `✏️ ${b("This one has too many items for the form.")}`,
    `Tell me the change instead — ${b("make it 400k")}, ${b("due next Friday")}, ${b("client is Zenith Homes")}.`,
  ),


  /**
   * Too small to be worth sending, with the reason rather than the rule.
   *
   * "Minimum ₦1,000" is a policy nobody agreed to. The fees are the actual
   * reason — on the free plan they start at ₦100 whatever the invoice is
   * worth, so a ₦400 invoice hands over a quarter of itself and a ₦100 one
   * would settle for less than nothing. Saying that is also the only version
   * somebody can act on: bill for more, or bill for several things at once.
   */
  amountTooSmall: (totalKobo: number): string =>
    para(
      `🪙 ${b(`${formatNaira(totalKobo)} is too small to invoice.`)}`,
      lines(
        `The smallest is ${b(formatNaira(MIN_INVOICE_KOBO))} — under that the fees take most of it,`,
        "because they start at a flat ₦100 however small the invoice is.",
      ),
      "Bill for more, or put a few things on one invoice.",
    ),

  /**
   * Too large to be a real invoice, which is almost always a stray digit.
   *
   * It says the figure back. Somebody who meant ₦500,000 and typed a zero too
   * many reads "₦5,000,000" and sees it at once; a message that only quoted
   * the limit would leave them working out what they had actually typed.
   */
  amountTooLarge: (totalKobo: number): string =>
    para(
      `🔍 ${b(`${formatNaira(totalKobo)} — is that right?`)}`,
      lines(
        `That is over ${b(formatNaira(MAX_INVOICE_KOBO))}, which is the most one invoice can be.`,
        "I have not drafted it, in case a digit slipped.",
      ),
      "If it really is that large, send it as more than one invoice.",
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

  /**
   * Somebody being a person rather than asking for something.
   *
   * These used to reach `outOfScope`, so "thank you" was answered with "I
   * only do quotes, invoices and payments — try: Invoice Tunde 20k". The
   * sentence is accurate and it is the wrong answer: nobody asked what this
   * does. It reads as a machine that was not listening, which is the one
   * impression a product living inside a chat cannot afford.
   *
   * Three replies rather than one, because a compliment and a goodnight do
   * not want the same answer. None of them carries a nudge: a prompt to go
   * and invoice somebody, attached to "thanks", is a shop assistant
   * following you to the door.
   *
   * A greeting is the fourth kind and is not here, because it already has a
   * better answer than a sentence — the tappable menu, which is what "hi"
   * has always opened. See the social branch.
   */
  social: (kind: Exclude<SocialKind, "greeting">): string => {
    switch (kind) {
      case "thanks":
        return `👍 ${b("Any time.")}`;
      case "praise":
        return `🙏 ${b("Glad it is working for you.")}`;
      case "farewell":
        return `👋 ${b("Talk soon.")}`;
    }
  },

  /**
   * A picture arrived, and we do not assume what it is for.
   *
   * Every image used to be saved as a logo on sight, on the reasoning that
   * the only sensible thing to send an invoicing bot is a logo. People send
   * screenshots — of a bank alert, of a chat, of an invoice that looks wrong
   * — and every one of those quietly replaced the logo on all their future
   * invoices, with a message saying so that is easy to scroll past.
   *
   * One question costs one message and removes the whole class of it.
   */
  isThisYourLogo: para(
    `🖼️ ${b("Is this your logo?")}`,
    "If it is, it goes on every invoice and quote you send from now on.",
  ),

  logoButtons: (): ReplyButton[] => [
    { id: "yes", title: "Yes, use it" },
    { id: "no", title: "No" },
  ],

  /**
   * How a logo gets on and off an invoice (F21, Pro).
   *
   * Both halves, because the settings row is the first place anybody learns
   * that either is possible. The image arrives as an ordinary WhatsApp photo
   * and is confirmed before it goes anywhere near a document.
   */
  logoHow: para(
    `\u{1F5BC}\uFE0F ${b("Send me the image.")}`,
    lines(
      "Any photo of your logo, PNG or JPG, on a plain background if you have one.",
      "I will show it to you before it goes on anything.",
    ),
    `To take it off again, say ${b("remove my logo")}.`,
  ),

  /**
   * They opened a setting and changed their mind.
   *
   * Says what did not happen, because the worry on the way out of a settings
   * screen is whether something was changed by accident.
   */
  settingUnchanged: para(
    `\u{1F44D} ${b("Left it as it was.")}`,
    `Nothing has changed. Say ${b("settings")} whenever you want to look again.`,
  ),

  /** They said no. Nothing was saved and nothing needs explaining. */
  logoDeclined: para(
    `👍 ${b("Left it alone.")}`,
    "Your invoices are unchanged. Send it again any time if you change your mind.",
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

  /**
   * The message the quote Flow arrives on.
   *
   * Same shape as the invoice one. The sentence still works and is still
   * faster for anything it can express, which is most quotes.
   */
  quoteFormBody: para(
    `\u{1F4C4} ${b("New quote")}`,
    "Tap below to fill it in.",
    i("Or just say it: Quote Zenith 350k for renders"),
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

  /** The message the payment request Flow arrives on. */
  requestFormBody: para(
    `\u{1F4B0} ${b("Payment request")}`,
    "Tap below to fill it in.",
    i("Or just say it: Collect 20k from Tunde"),
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

  /*
   * A tapped settings row wins over whatever question is open.
   *
   * Section 5 already says "a new command always wins over a pending
   * question, so users are never trapped", and a tap is the least ambiguous
   * command in the product — there is no chance it was meant as prose. But a
   * row id arrives as plain text, so the free-text steps could not tell, and
   * one of them wrote "Delete My Account" into a business name.
   *
   * Only these six, and only when tapped. Typing the same words still reads
   * as words, which matters: a business can be called almost anything.
   */
  if (msg.tapped && SETTINGS_ROW_IDS.includes(text.toLowerCase().trim() as SettingsRowId)) {
    return atSettingsMenu(text, { ...context, attempts: 0 }, msg);
  }

  // A paused account can still ask for help, and nothing else (section 5).
  if (state === "paused") {
    return { replies: [VOICE.paused], next: state, context, effects: [] };
  }

  /*
   * Money that is not naira, refused before anything reads it as naira.
   *
   * At the top rather than beside the draft, and that placement is the point.
   * A foreign amount can arrive as a new invoice, as a correction to one on
   * screen ("change it to $600"), or as the answer to "how much?" — three
   * different code paths, each of which would otherwise hand "$600" to a
   * reader that strips the mark and returns ₦600. One guard covering every
   * way into the machine is the only version of this that cannot be got round
   * by a route nobody thought of.
   *
   * It runs whether or not international invoicing is switched on. The flag
   * decides whether we can *take* dollars; it must never decide whether we
   * can *see* them.
   */
  const refusal = msg.parsed?.money ? foreignRefusal(msg.parsed.money, msg.quote) : null;
  if (refusal) return { replies: [refusal], next: state, context, effects: [] };

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
  /*
   * Not at "new", which answers every message with the setup card and has
   * its own words for each of these. The menu is ten slash commands, nine of
   * which need the account that does not exist yet, and handing that to
   * somebody's first message is the worst answer in the product.
   */
  if ((HELP.test(text) || msg.parsed?.intent === "help") && state !== "new") {
    const faq = faqKind(text);

    if (state.startsWith("onboarding")) {
      // Mid-onboarding, help is about the question on the screen. Offering the
      // whole menu there invites somebody to wander off a form they are three
      // fields into — and half of that menu needs an account to work.
      //
      // A named question is answered first, then the step repeated. Somebody
      // asking where their money goes while typing their account number is
      // asking about the thing they are being asked to hand over, and
      // "what is your bank?" on its own is not an answer to it.
      return {
        replies: [faq ? para(faqAnswer(faq), onboardingHelp(state)) : onboardingHelp(state)],
        next: state,
        context,
        effects: [],
      };
    }

    /*
     * "Is my money safe?", from somebody already set up.
     *
     * The menu does not answer it and never will — there is no command for
     * where the money goes. "How does this work" is different: somebody with
     * an account asking that wants the list of what they can type, which is
     * exactly what the menu is.
     */
    if (faq === "safety") {
      return { replies: [VOICE.moneySafe], next: state, context, effects: [] };
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
    /*
     * Just the refusal while the form is open.
     *
     * It used to carry the whole "What I can do" menu underneath — every
     * command listed, almost all of them refused for the same reason as the
     * one they just tried. Somebody asking for one command does not need a
     * list of nine they cannot use yet.
     */
    const question = pendingQuestion(state);
    return {
      replies: [question ? para(VOICE.setupBeforeCommands, question) : VOICE.setupBeforeCommands],
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
    case "new": {
      /*
       * Anything at all begins onboarding. A greeting is the common case, but
       * someone who opens with "invoice Tunde 20k" should not be told off:
       * take them through setup and their instruction still stands afterwards.
       *
       * Setup is a form rather than six questions. Business name, email, bank
       * and account number are four things they already know, and asking for
       * them one at a time is four chances to wander off — plus four
       * chargeable messages from October 2026.
       *
       * Four things can arrive here, because four things are offered above an
       * empty chat, and each gets its own opening line under the same card
       * and the same button. One message either way: the answer and the way
       * to start are the same bubble, so nothing is a dead end.
       */
      const faq = faqKind(text);
      const asking = faq !== null || HELP.test(text);
      const starting = SETUP_ME.test(text.trim()) || GREETING.test(text);

      const body = faq
        ? para(faqAnswer(faq), SETUP_NUDGE)
        : HELP.test(text)
          ? // "Help", from a stranger, is the same question as "how does this
            // work" and wants the same three lines rather than the menu.
            para(VOICE.howItWorks, SETUP_NUDGE)
          : starting
            ? VOICE.setupInvite
            : VOICE.setupFirst;

      return {
        replies: [],
        next: "onboarding:form",
        /*
         * Their instruction, kept — this is the whole of "then I can do that".
         *
         * Only an instruction. A greeting, a question and a request for help
         * were all answered just now, and replaying one of them at the end of
         * setup would be the bot repeating itself four minutes later.
         */
        context: asking || starting ? {} : { opener: text },
        effects: [
          {
            type: "send_flow",
            key: "onboarding",
            body,
            cta: "Set up Balans",
            image: WELCOME_CARD,
          },
        ],
      };
    }

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
      /*
       * "Set me up", tapped while the form is already on screen.
       *
       * The suggestion is still there to tap until they send something, and
       * a second tap is an ordinary thing to do when a form has not opened.
       * Without this it is not a greeting, so it becomes the answer to the
       * question underneath — and the business goes on every invoice they
       * ever send called "👋 Set me up".
       */
      if (SETUP_ME.test(text.trim())) {
        return {
          replies: [
            para(`\u{1F44B} ${b("The form is the message just above.")}`, onboardingHelp(state)),
          ],
          next: "onboarding:form",
          context,
          effects: [],
        };
      }

      if (GREETING.test(text)) {
        return { replies: [VOICE.setupByHand], next: "onboarding:business_name", context, effects: [] };
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
      return takeConsent(text, context, consentVersion, today(msg));

    /*
     * "Is this your logo?", answered.
     *
     * A picture used to be saved as a logo on sight. People send screenshots
     * — a bank alert, a chat, an invoice that looks wrong — and every one of
     * them silently replaced the logo on all their future invoices.
     *
     * Anything that is not a yes or a no drops the picture and is read as an
     * ordinary message, which is section 5's rule: a new command always wins
     * over a pending question, so nobody is trapped. Somebody who sends a
     * screenshot and then types "invoice Tunde 20k" gets the invoice.
     */
    case "awaiting_logo_confirm": {
      const pending = context.pendingLogo;
      const { pendingLogo: _drop, ...rest } = context;

      // `asCommand` owns the list of what counts as yes and no, including
      // "na so" and "e correct". A third regex here would be a third answer
      // to a question already settled twice.
      const answer = asCommand(text)?.intent;

      if (pending && answer === "confirm") {
        return {
          replies: [],
          next: "idle",
          context: rest,
          effects: [{ type: "save_logo", mediaId: pending }],
        };
      }

      if (answer === "reject") {
        return { replies: [VOICE.logoDeclined], next: "idle", context: rest, effects: [] };
      }

      return step("idle", rest, msg, consentVersion);
    }

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
      return takeNewBusinessName(text, context, msg);

    case "settings:invoice_number":
      return takeInvoiceNumber(text, context, msg);

    case "settings:due_days":
      return takeDueDays(text, context, msg);

    case "settings:bank_code":
      return takeBankChangeCode(text, context);

    case "settings:bank_details":
      return takeNewBankDetails(text, context);

    case "settings:bank_confirm":
      return confirmNewBank(text, context, msg);

    case "settings:delete_confirm":
      return confirmDeletion(text, context, msg);
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

  /*
   * F21, Pro. The row only exists for somebody who can have a logo, so this
   * explains both ends of it: an image adds one and a phrase takes it away.
   * Nothing here needs to know whether one is set - both answers are useful
   * either way, and the row above already said which it is.
   */
  if (/^(logo|my logo|change (my )?logo|set (my )?logo)\b/.test(s)) {
    return { replies: [VOICE.logoHow], next: "idle", context: forget(ctx), effects: [] };
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

/**
 * The ways somebody says they have changed their mind.
 *
 * A settings question used to have no answer except the one it asked for.
 * Somebody who opened "change business name" and thought better of it typed
 * "i dont want to change it again" \u2014 and that became their business name,
 * printed on their invoices and on the page their clients pay from. It is
 * letters, it is the right length, and every rule the validator had let it
 * straight through.
 *
 * So there is a door now. The phrases are the ones people actually use when
 * they mean to leave, and the sentence above is one of them, because it was.
 */
const CHANGED_MY_MIND =
  /^(?:cancel|never ?mind|forget it|leave it(?: as it is)?|no|nope|nah|stop|back|exit|quit|skip|i(?:'| a)?m (?:good|fine|ok(?:ay)?)|i (?:do ?n(?:o|')?t|dont|don't) want to change (?:it|this|my name|the name|anything)?(?: again)?)[.!]?$/i;

/**
 * A way out of a settings question, or null to carry on asking.
 *
 * Two doors: saying so, and asking for something else entirely. The second
 * was already computed for every state and simply never consulted here, which
 * is why "/pro" was answered twice with "that does not look like a business
 * name" \u2014 a slash command being told it is a bad name is the bot arguing
 * with somebody who has plainly moved on.
 */
function leaveSetting(text: string, ctx: Context, msg: Inbound, now: Civil): Step | null {
  if (CHANGED_MY_MIND.test(text.trim())) {
    return { replies: [VOICE.settingUnchanged], next: "idle", context: forget(ctx), effects: [] };
  }
  return commandEscape(msg, ctx, now);
}

function takeNewBusinessName(text: string, ctx: Context, msg: Inbound): Step {
  const out = leaveSetting(text, ctx, msg, today(msg));
  if (out) return out;

  const name = text.replace(/\s+/g, " ").trim();

  /*
   * The same rules as setup, because it is the same field.
   *
   * This checked the length and nothing else, so everything onboarding
   * refuses — an email address, a URL, "delete my account" — was accepted
   * here and written straight to the invoices. A live account is called
   * "Delete My Account" because of this branch: the phrase is an instruction
   * everywhere else in the product and a name only here.
   *
   * Two validators for one field was the whole bug, so there is now one.
   */
  const wrong = nameProblem(name);
  if (wrong) {
    return retry(
      "settings:business_name",
      ctx,
      lines(wrong, `Send the name your clients would recognise — like ${b("Kemi Adeyemi Studio")}.`),
    );
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
function takeInvoiceNumber(text: string, ctx: Context, msg: Inbound): Step {
  const out = leaveSetting(text, ctx, msg, today(msg));
  if (out) return out;

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

function takeDueDays(text: string, ctx: Context, msg: Inbound): Step {
  const out = leaveSetting(text, ctx, msg, today(msg));
  if (out) return out;

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
function confirmDeletion(text: string, ctx: Context, msg: Inbound): Step {
  const s = text.trim().toLowerCase();

  /*
   * Typed, never tapped.
   *
   * The settings row used to carry this exact phrase as its id, so tapping
   * it asked "send exactly: delete my account" and tapping the same row
   * again sent exactly that — one tap from irreversible, with the typing
   * requirement defeated by the thing it was protecting against.
   *
   * The id has changed, but a list sent before that change is still sitting
   * in people's chats and its rows are still tappable. So this refuses a tap
   * whatever it says. Asking somebody to type four words is the entire
   * protection here; a tap is not typing.
   */
  if (msg.tapped) return retry("settings:delete_confirm", ctx, VOICE.confirmDelete);

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
      return startDocument(p, ctx, now, msg.quote);

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

    case "signature":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "show_signature" }] };
    case "remove_signature":
      return { replies: [], next: "idle", context: ctx, effects: [{ type: "remove_signature" }] };

    case "status":
    case "stop_reminders":
    case "cancel_document":
    case "resend_document":
    case "convert_quote":
    case "edit_document":
    case "record_payment":
    case "confirm_payment":
    case "decline_payment":
      return {
        replies: [],
        next: "idle",
        context: ctx,
        effects: [{ type: "document_action", intent: p.intent, number: p.documentNumber }],
      };

    /*
     * A pleasantry. Answered as one, and nothing else happens.
     *
     * The kind is worked out from the message here rather than carried on the
     * parse, so the pattern path and the model path read the same list. When
     * the model calls something social that the list does not recognise, a
     * plain thank-you is the safest of the four: it acknowledges without
     * assuming the message was a greeting or a compliment.
     */
    case "social": {
      const kind = socialKind(msg.text) ?? "thanks";

      // A greeting opens the menu, which is what "hi" has always done and is
      // a better answer than a sentence: something to tap rather than a list
      // of words to retype. Routed here too so the model path and the
      // pattern path cannot answer the same "good morning" differently.
      if (kind === "greeting") {
        return {
          replies: [],
          next: "idle",
          context: ctx,
          effects: [{ type: "show_help", fallback: VOICE.helpIdle }],
        };
      }

      return { replies: [VOICE.social(kind)], next: "idle", context: ctx, effects: [] };
    }

    // A stray "yes" with nothing to confirm, and everything unrecognised.
    case "confirm":
    case "reject":
      return {
        replies: [VOICE.nothingPending],
        buttons: VOICE.helpButton(),
        next: "idle",
        context: ctx,
        effects: [],
      };

    default:
      /*
       * A draft button tapped on a bubble whose draft is gone.
       *
       * A WhatsApp message lasts for ever and its buttons stay tappable, so
       * "Change it" on an invoice sent twenty minutes ago is an ordinary
       * thing to do. The id arrives as the text "change something", nothing
       * in idle reads it, and the answer was "I only do quotes, invoices and
       * payments" — which reads as the bot forgetting what it had just sent.
       *
       * "Send it" and "Discard" were already fine by accident: their ids are
       * "yes" and "no", which the parser calls confirm and reject, and those
       * land on the same message two cases above. This is the third button
       * joining them rather than a new idea.
       *
       * The ids come from `draftButtons` so renaming one cannot quietly
       * bring the old answer back.
       */
      if (DRAFT_BUTTONS.has(msg.text.trim().toLowerCase())) {
        return {
        replies: [VOICE.nothingPending],
        buttons: VOICE.helpButton(),
        next: "idle",
        context: ctx,
        effects: [],
      };
      }

      return { replies: [VOICE.outOfScope], next: "idle", context: ctx, effects: [] };
  }
}

/** The three answers to "Send it?", by id. Tapped long after the draft has gone. */
const DRAFT_BUTTONS = new Set(draftButtons().map((b) => b.id));

/** Turns a parse into a document under construction, then asks or drafts. */
function startDocument(p: Parsed, ctx: Context, now: Civil, quote?: Quote): Step {
  const doc: PendingDoc = {
    type:
      p.intent === "create_quote"
        ? "quote"
        : p.intent === "payment_request"
          ? "payment_request"
          : "invoice",
    clientName: p.clientName ?? undefined,
    clientEmail: p.clientEmail,
    /*
     * Straight off the parse, which means kobo on a naira message and cents
     * or pence on one written abroad. `repriced` below is the seam where the
     * second becomes the first; above it a parse is in whatever currency it
     * was written in, and below it everything is naira, as every total, part,
     * fee, reminder and summary in this product has always been.
     */
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
  const priced = p.money.kind === "foreign" && quote ? repriced(doc, quote) : doc;
  return buildOrAsk(priced, ctx, now, unreadableDate);
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
     * A request gets one screen rather than two: there is no due date, no VAT
     * and no payment plan on it, because there is no document for any of that
     * to print on.
     *
     * The state still moves to `awaiting_field:client_name`, because a form
     * on the screen does not stop somebody typing the answer underneath it,
     * and they should not have to open it.
     */
    const form = {
      invoice: { key: "invoice", body: VOICE.invoiceFormBody, cta: "Fill in the invoice" },
      quote: { key: "quote", body: VOICE.quoteFormBody, cta: "Fill in the quote" },
      payment_request: { key: "request", body: VOICE.requestFormBody, cta: "Fill in the request" },
    }[doc.type];

    return {
      replies: [],
      next: "awaiting_field:client_name",
      context,
      effects: [
        {
          type: "send_flow",
          key: form.key as "invoice" | "quote" | "request",
          body: form.body,
          cta: form.cta,
          /*
           * A blank form still opens on its data, not on none.
           *
           * With nothing handed over, every `${data.x}` the form binds was
           * undefined: the currency box showed to free accounts as
           * "Optional", Amount lost its line, and the date picker had no
           * floor. The request form declares none of these, so it opens bare.
           */
          ...(doc.type === "payment_request" ? {} : formValues({ type: doc.type, lines: [] }, now)),
          fallback: { line: template, holdAt: "awaiting_field:client_name" },
        },
      ],
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
      buttons: [CHANGE_NAME],
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
 * field that silently opens blank. Numbers on WORK and strings elsewhere,
 * because that is what each screen declares and what its inputs expect.
 *
 * The date goes across as words rather than a calendar value: the field takes
 * words, and the same reader handles "8 October 2026" as handles "Friday".
 */
function formValues(doc: PendingDoc, now: Civil): {
  screen: string;
  data: Record<string, string | number | boolean>;
} {
  /*
   * One unit's price, in the currency the form will read it in.
   *
   * The price of one, not the line: the quantity has its own box now, and a
   * line reopened as its total with the quantity dropped is "4 stills at
   * ₦20,000" coming back as one still at ₦80,000.
   *
   * And the agreed price on a foreign draft, not the naira it converted to.
   * The currency box reopens on dollars, so the figure under it has to be
   * dollars: sent the kobo figure, a $500 draft reopened at "663500" and
   * tapping Next priced it at $663,500 — the conversion done twice, which is
   * the failure dollar-draft.test.ts exists for, through the form.
   */
  const unit = (l: { unitAmountKobo: number; originalUnitAmountMinor?: number }): number =>
    (doc.foreign ? (l.originalUnitAmountMinor ?? l.unitAmountKobo) : l.unitAmountKobo) / 100;
  /** Empty for one, which is what the box says when nobody has touched it. */
  const qtyText = (l: { qty: number } | undefined): string => (l && l.qty !== 1 ? String(l.qty) : "");

  const first = doc.lines[0];

  /*
   * Which screen, and therefore which fields.
   *
   * The form is one screen per number of items now, and a screen is handed
   * exactly the keys it declares — one extra kills the Flow, and so does one
   * missing. So the count decides both: WORK for a single line, because its
   * Amount is a number input and the number pad is worth having, and
   * WORK_TWO upwards for a draft that already has more.
   */
  const items = Math.min(Math.max(doc.lines.length, 1), EXTRA_ITEMS.length + 1);
  const onEntry = items <= 1;
  const iso = (c: Civil): string => `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

  const values: Record<string, string | number | boolean> = {
    client_name: doc.clientName ?? "",
    client_email: doc.clientEmail ?? "",
    client_phone: doc.clientPhone ?? "",
    description: first?.description ?? "",
    /*
     * The first item's own amount, not the document total.
     *
     * It used to be the total, which was the same number while a form could
     * only hold one line. A three-line draft from a sentence would reopen
     * with line one's description against all three lines' money — and
     * tapping Next accepted it, turning ₦50k of logo work into ₦300k.
     */
    /*
     * A number on WORK and a string on every other form screen, because that
     * is what each one declares. WORK initialises an `input-type: "number"`
     * box; the screens you come back to take a string, since a string is all
     * a form ever returns and Flow JSON has no cast.
     */
    amount: ((a) => (onEntry ? a : String(a)))(
      first
        ? unit(first)
        : Math.round((doc.foreign ? doc.foreign.amountMinor : (doc.totalKobo ?? 0)) / 100),
    ),
    /*
     * WORK's box is a number input and has to be handed a number, so a
     * one-line draft reopens showing "1". Every other screen takes a string
     * and shows one only when it is not one.
     */
    qty: onEntry ? (first?.qty ?? 1) : qtyText(first),
    // What the date picker returns and takes: YYYY-MM-DD.
    due_date: doc.dueDate ? iso(doc.dueDate) : "",
    today: iso(now),
    plan: planIdFor({ depositPercent: doc.depositPercent, instalments: doc.instalments }),
    notes: doc.notes ?? "",
    vat: doc.vatPercent != null,
    /*
     * What the draft is priced in, and whether the box that says so is even
     * shown (International PRD section 5).
     *
     * Hidden by default and naira by default, because this function is pure
     * and cannot ask what plan somebody is on. The caller knows, and turns it
     * on where it applies — see `openedAbroad` in handle.ts. Defaulting the
     * other way would put a currency box in front of every freelancer sending
     * an ordinary naira invoice.
     */
    currency: doc.foreign?.currency ?? "",
    can_bill_abroad: false,
    amount_help: NAIRA_HELP,
  };

  /*
   * The rest of the items — exactly the ones this screen has boxes for.
   *
   * Not all four. A screen is handed the keys it declares and no others, and
   * WORK_THREE declares two extras, so sending four is fatal in the same way
   * sending none would be. Anything past the fifth line cannot be shown at
   * all; that is what `overflowsForm` is for.
   */
  EXTRA_ITEMS.slice(0, items - 1).forEach((w, index) => {
    const line = doc.lines[index + 1];
    const f = itemFields(w);
    values[f.description] = line?.description ?? "";
    values[f.qty] = qtyText(line);
    values[f.amount] = line ? String(unit(line)) : "";
  });

  /*
   * A draft with one item opens on the first page, who it is for, and
   * carries its item to the second. One with more opens on the page that
   * holds all of them: there is one "who" page and it can only hand on to
   * the one-item form, and a second copy per item count is five more screens
   * for the rare edit that is about the client rather than the work — which
   * is a sentence away anyway ("change the client to Daniel").
   */
  return { screen: onEntry ? "WHO" : formScreenId(items), data: values };
}

/**
 * Whether a draft has more lines than the form can hold.
 *
 * A sentence takes up to twenty items and the form takes five, so this is
 * reachable by ordinary use. Opening the form on such a draft would show the
 * first five and silently drop the rest on submit, which is somebody's
 * invoice quietly shrinking, so the caller offers words instead.
 */
export const overflowsForm = (doc: PendingDoc): boolean => doc.lines.length > EXTRA_ITEMS.length + 1;

const totalOf = (doc: PendingDoc): number =>
  doc.lines.length
    ? doc.lines.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0)
    : (doc.totalKobo ?? 0);

/**
 * The draft on screen, for the parser to read alongside the reply.
 *
 * "correct the work, it is photography" is a sentence about nothing until you
 * know what is in front of the person who typed it. This is that context, and
 * only that: our own fields, out of our own store, written plainly.
 *
 * Deliberately not the summary the user sees. That one is formatted for a
 * phone — bold runs, emoji, a question at the end — and none of it helps a
 * parser, while the "Send it?" at the bottom is the sort of thing a model
 * reads as an instruction. The date goes in as ISO because this is the one
 * reader that must never have to interpret "Thu, 1 Oct".
 */
export function draftOnScreen(doc: PendingDoc): string {
  const total = totalOf(doc);
  const work =
    doc.lines.length === 1
      ? doc.lines[0]!.description
      : doc.lines.length
        ? `${doc.lines.length} items`
        : null;

  return [
    `kind: ${doc.type}`,
    doc.clientName ? `client: ${doc.clientName}` : null,
    work ? `item: ${work}` : null,
    total ? `amount: ${formatNaira(total)}` : null,
    doc.dueDate ? `due: ${doc.dueDate.y}-${pad(doc.dueDate.m)}-${pad(doc.dueDate.d)}` : null,
    doc.vatPercent ? `vat: ${doc.vatPercent}%` : null,
    doc.depositPercent ? `deposit: ${doc.depositPercent}%` : null,
    doc.instalments ? `instalments: ${doc.instalments}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Kept local rather than imported, so the machine stays free of side effects. */
function addDaysTo(c: Civil, days: number): Civil {
  const at = new Date(Date.UTC(c.y, c.m - 1, c.d) + days * 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/* -------------------------------------------------------------------------- */

/** The answer to a single question, and nothing else. */
function takeMissingField(state: State, text: string, ctx: Context, msg: Inbound): Step {
  const doc = ctx.doc;
  if (!doc) {
    return {
      replies: [VOICE.nothingPending],
      buttons: VOICE.helpButton(),
      next: "idle",
      context: {},
      effects: [],
    };
  }

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

  /*
   * The name, changed while something else is being asked.
   *
   * "How much is Hi paying?" is what somebody got for saying hello to an
   * empty invoice, and neither "change the name to Daniel" nor anything else
   * they typed could get them out of it: every message was read as an amount
   * and refused. The button under the question sends CHANGE_NAME's id; the
   * sentence carries the new name with it.
   */
  if (state !== "awaiting_field:client_name") {
    if (CHANGE_NAME_ASK.test(answer)) {
      return {
        replies: [askFor("client_name", {})],
        next: "awaiting_field:client_name",
        context: { ...ctx, doc: { ...doc, clientName: undefined }, attempts: 0 },
        effects: [],
      };
    }
    const renamed = CHANGE_NAME_TO.exec(answer)?.[1]?.replace(/\s+/g, " ").trim();
    if (renamed && renamed.length >= 2 && renamed.length <= 80) {
      return buildOrAsk({ ...doc, clientName: titleCaseName(renamed) }, ctx, now);
    }
  }

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
        // "Hi" on an invoice is somebody saying hello, not naming a client.
        GREETING.test(name) ||
        SETUP_ME.test(name) ||
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
        return {
          ...retry("awaiting_field:amount", ctx, askFor("amount", { clientName: doc.clientName })),
          buttons: [CHANGE_NAME],
        };
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
      return {
        replies: [VOICE.nothingPending],
        buttons: VOICE.helpButton(),
        next: "idle",
        context: {},
        effects: [],
      };
  }
}

/* -------------------------------------------------------------------------- */

/** The draft is on screen. Confirm, reject, correct, or change the subject. */
function atConfirm(text: string, ctx: Context, msg: Inbound): Step {
  const doc = ctx.doc;
  if (!doc || !ctx.draftId) {
    return {
      replies: [VOICE.nothingPending],
      buttons: VOICE.helpButton(),
      next: "idle",
      context: {},
      effects: [],
    };
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
    /*
     * A total, said vaguely, on a draft with more than one line.
     *
     * Applying it collapses every line into one — which is the right answer
     * on a one-line draft and a silent deletion on any other. "Make it 400k"
     * against three items does not say whether it means all three together
     * or the one they were looking at, and the cost of guessing wrong is two
     * lines of somebody's work.
     *
     * So it asks, and asks with the list in front of them. Only for a total
     * nobody named: "change the total to 400k" says which figure it means
     * and still does exactly what it says.
     */
    const vague = msg.correction.totalKobo;
    if (vague !== undefined && !msg.correction.totalMeansWhole && doc.lines.length > 1) {
      return {
        replies: [VOICE.whichItem(doc, vague)],
        buttons: draftButtons(),
        next: "awaiting_confirm",
        context: ctx,
        effects: [],
      };
    }

    return buildOrAsk(applyCorrection(doc, msg.correction, msg.quote), ctx, now);
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
    /*
     * A draft with more lines than the form holds stays in words.
     *
     * The form has five slots and a sentence takes twenty, so this is
     * ordinary use rather than an edge. Opening the form here would show the
     * first five lines and drop the rest the moment they tapped Next — an
     * invoice quietly shrinking inside the thing that was meant to correct
     * it. Typing the change never had that problem.
     */
    if (overflowsForm(doc)) {
      return retry("awaiting_confirm", { ...ctx, attempts: 0 }, VOICE.tooManyLinesToForm);
    }

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
          ...formValues(doc, now),
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

/**
 * A correction applied to a draft, in the currency that draft is in.
 *
 * On a naira invoice this is the whole of it. On one priced abroad it is the
 * middle of a sandwich: the draft is turned back into dollars, the correction
 * is applied there, and the result is converted again — because a correction
 * arrives in the invoice's own currency and must be applied to figures in
 * that currency.
 *
 * The case that makes it necessary is the quiet one. "make it 600" against a
 * dollar draft carries no mark at all, so nothing downstream could tell it
 * from six hundred naira; applied to the kobo figures it would turn a $500
 * invoice into one for ₦600. The mark is not what says this is dollars — the
 * invoice is.
 */
function applyCorrection(doc: PendingDoc, c: Correction, quote?: Quote): PendingDoc {
  if (!doc.foreign) return applyIn(doc, c);

  /*
   * Back into cents or pence: the price as agreed, which is what the user is
   * looking at and what their correction is about.
   */
  const agreed: PendingDoc = {
    ...doc,
    lines: doc.lines.map((l) => ({
      ...l,
      unitAmountKobo: l.originalUnitAmountMinor ?? l.unitAmountKobo,
    })),
    totalKobo: doc.totalKobo === undefined ? undefined : doc.foreign.amountMinor,
  };

  /*
   * And converted again, at today's rate if one came with the message.
   *
   * Section 6: "If the user edits the amount, re-quote with the current
   * rate." An edit is a different invoice, and pricing a different invoice at
   * a rate fetched for the one before it is the one case where the locked
   * rate is the wrong answer. Without a fresh quote the draft keeps the rate
   * it had, which is right for a correction that did not touch the money.
   */
  return repriced(applyIn(agreed, c), quote ?? doc.foreign);
}

/**
 * A draft whose figures are in a foreign currency, converted into naira.
 *
 * `at` is either a fresh quote or the one already on the draft; both carry a
 * rate and a source, and which it is has already been decided above.
 */
export function repriced(
  doc: PendingDoc,
  at: { currency: Foreign; rate: number; source: string; fetchedAt: string | Date },
): PendingDoc {
  const lines = doc.lines.map((l) => ({
    description: l.description,
    qty: l.qty,
    originalUnitAmountMinor: l.unitAmountKobo,
    unitAmountKobo: nairaKoboFor(l.unitAmountKobo, at.rate),
  }));

  const amountMinor = lines.length
    ? doc.lines.reduce((t, l) => t + l.unitAmountKobo * l.qty, 0)
    : (doc.totalKobo ?? 0);

  return {
    ...doc,
    lines,
    totalKobo: lines.length ? undefined : nairaKoboFor(amountMinor, at.rate),
    foreign: {
      currency: at.currency,
      amountMinor,
      rate: at.rate,
      source: at.source,
      fetchedAt: typeof at.fetchedAt === "string" ? at.fetchedAt : at.fetchedAt.toISOString(),
    },
  };
}

function applyIn(doc: PendingDoc, c: Correction): PendingDoc {
  const next: PendingDoc = { ...doc };

  if (c.clientName) next.clientName = c.clientName;
  // Null is an instruction here, not an absence: "no email" takes the address
  // off, and `undefined` is the field nobody mentioned.
  if (c.clientEmail !== undefined) next.clientEmail = c.clientEmail;
  // A number that is not one is left as it was rather than wiped.
  if (c.clientPhone === null) next.clientPhone = null;
  else if (c.clientPhone) next.clientPhone = normalisePhone(c.clientPhone) ?? next.clientPhone;
  if (c.dueDate) next.dueDate = c.dueDate;

  /*
   * A date for one part of the payment plan.
   *
   * Resolved here rather than in the reader because only this side knows how
   * many parts there are: "the balance" is part two of a deposit and part
   * five of five instalments. A date set for a part that does not exist —
   * "part 4" of a two-part plan — is left alone rather than guessed at.
   */
  if (c.stageDue) {
    const count = shapeFor(next, totalOf(next))?.length ?? 0;
    const at =
      c.stageDue.which === "first"
        ? 0
        : c.stageDue.which === "last"
          ? count - 1
          : c.stageDue.which - 1;

    if (count > 0 && at >= 0 && at < count) {
      const dates = [...(next.stageDueDates ?? [])];
      dates[at] = c.stageDue.date;
      next.stageDueDates = dates;

      // The last part IS the document's due date; they are one fact with two
      // names, and letting them drift apart puts two dates on one card.
      if (at === count - 1) next.dueDate = c.stageDue.date;
    }
  }
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

  /*
   * Whole lines, added and taken away.
   *
   * Before the amount rule below, which replaces the price of a single line
   * and collapses several into one — running it after an add would undo the
   * add. Nobody writes a message that means both.
   */
  if (c.addLines?.length) {
    next.lines = [
      ...next.lines,
      ...c.addLines.map((l) => ({ description: l.description, qty: 1, unitAmountKobo: l.unitAmountKobo })),
    ];
    // The total is whatever the lines add up to now, not what it was.
    next.totalKobo = undefined;
  }

  /*
   * Rewording a line, keeping its price.
   *
   * Before the removal, and deliberately not expressible as one: a rename
   * that arrives as remove-then-add loses the whole line the moment the add
   * is dropped for having no price. A name that matches nothing leaves the
   * draft alone rather than renaming whichever line came first.
   */
  if (c.renameLine) {
    const needle = c.renameLine.match.toLowerCase();
    const at = next.lines.findIndex((l) => l.description.toLowerCase().includes(needle));
    if (at >= 0) {
      next.lines = next.lines.map((l, i) =>
        i === at ? { ...l, description: c.renameLine!.to } : l,
      );
    }
  }

  if (c.removeLine && next.lines.length > 1) {
    /*
     * Only ever one line, and never the last one.
     *
     * An invoice with nothing on it is not a document, and "remove the
     * design" against a one-line draft means they want a different invoice,
     * not an empty one — so it is left alone and the summary comes back
     * unchanged, which shows them what they still have.
     */
    const at =
      "position" in c.removeLine
        ? c.removeLine.position - 1
        : next.lines.findIndex((l) =>
            l.description.toLowerCase().includes(c.removeLine && "match" in c.removeLine ? c.removeLine.match.toLowerCase() : "\u0000"),
          );

    if (at >= 0 && at < next.lines.length) {
      next.lines = next.lines.filter((_, i) => i !== at);
      next.totalKobo = undefined;
    }
  }

  /*
   * A new price for one line, leaving the others exactly as they were.
   *
   * The correction this was missing. "change the ui amount to 400k" on a
   * three-item draft was read as a change to the invoice total, and a total
   * collapses a multi-line draft into a single line — so an invoice for
   * ₦1,250,000 across three items came back as one item at ₦400,000, with
   * two lines and ₦900,000 of work gone and nothing on screen to say so.
   *
   * A name that matches nothing leaves the draft alone, like the rename
   * above: changing whichever line happened to come first is how somebody
   * ends up sending a price they never typed.
   */
  if (c.setLineAmount) {
    const needle = c.setLineAmount.match.toLowerCase();
    const at = next.lines.findIndex((l) => l.description.toLowerCase().includes(needle));
    if (at >= 0) {
      next.lines = next.lines.map((l, i) =>
        // Quantity goes to one: they named what the line should come to, not
        // what one of several units of it should cost.
        i === at ? { ...l, qty: 1, unitAmountKobo: c.setLineAmount!.amountKobo } : l,
      );
      next.totalKobo = undefined;
    }
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
  // "pay" on its own is on the Pro card, in bold, as the thing to reply.
  if (/^(pay|pay now|pay link|payment link|send me the link|card|pay by card)$/.test(s)) {
    return "link";
  }
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
  /*
   * Things we say to this number, which are never anybody's business name.
   *
   * A live account is called "Delete My Account", because somebody typed that
   * during setup and it was taken as a name — it is letters, it is the right
   * length, and every rule above let it through. It then printed on their
   * invoices and on the payment page their client opens, which is where it
   * was found.
   *
   * Narrow on purpose, and narrower than "anything asCommand recognises":
   * that list includes "premium" and "dashboard", and a real business is
   * allowed to be called either. These are phrases that only ever mean an
   * instruction to us. The asymmetry above still holds — refusing a real name
   * is worse than accepting a wrong one — which is why this is a short list
   * and not a clever one.
   */
  {
    test: /^(?:delete|close|cancel|remove|stop)(?:\s+(?:my|the))?\s*(?:account|balans|everything)?$/i,
    why: "That is something you can tell me to do, not a name.",
  },
  { test: /^(?:help|menu|settings?|upgrade|cancel|stop|yes|no|start|restart)$/i, why: "That is a command, not a name." },
  // Last, so the ones above get to name themselves first.
  { test: /^\P{L}+$/u, why: "A name needs at least one letter in it." },
];

/**
 * Why this cannot be a business name, or null if it can.
 *
 * One function, used by setup and by the settings rename, because they are
 * the same field and disagreeing about it is how the field gets corrupted.
 *
 * A slash command is never a name. `step` refuses those before they reach
 * either caller; this does not take that on trust, because this is the field
 * that was actually corrupted by one.
 */
function nameProblem(name: string): string | null {
  if (name.length < 2 || name.length > 80 || name.startsWith("/")) {
    return "That does not look like a business name.";
  }
  return NOT_A_NAME.find((r) => r.test.test(name))?.why ?? null;
}

function takeBusinessName(text: string, ctx: Context, msg: Inbound): Step {
  const name = text.replace(/\s+/g, " ").trim();
  const wrong = nameProblem(name);

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

function takeConsent(text: string, ctx: Context, version: string, now: Civil): Step {
  if (/\b(i agree|agree|agreed|yes|accept|i accept)\b/i.test(text)) {
    /*
     * Setup is done, and they asked for something before any of it started.
     *
     * The card here invites them to create an invoice. Somebody whose first
     * message was "invoice Tunde 20k for logo design" has already asked for
     * one, and being offered a button to say it again is the bot admitting
     * it was not listening. Their own sentence is replayed instead, by the
     * caller, which is what `opener` has been carried through setup for.
     */
    if (ctx.opener) {
      return {
        replies: [VOICE.doneNowThat],
        next: "idle",
        context: { ...ctx, attempts: 0 },
        effects: [{ type: "record_consent", version }],
      };
    }

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
          ...formValues({ type: "invoice", lines: [] }, now),
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

/**
 * The fixed paragraph for one of the two questions asked before signing up.
 *
 * A function rather than a lookup at each call site so that every place that
 * answers one of these answers it with the same words — the point of writing
 * them down once is that somebody asking mid-setup and somebody asking on
 * their first message get the same product.
 */
function faqAnswer(kind: FaqKind): string {
  return kind === "safety" ? VOICE.moneySafe : VOICE.howItWorks;
}

/**
 * What to say about money that is not naira, or null to carry on.
 *
 * The four answers, in the order they are reached:
 *
 *   - naira, which is every message this product has ever had, and the only
 *     one that returns null and lets the machine do its job;
 *   - a currency we can name and will never take, refused by name;
 *   - two currencies at once, which is a question rather than an instruction;
 *   - dollars or pounds, which is the feature — and, until the flag is on and
 *     section 13's gate is cleared, a promise rather than a draft.
 *
 * The last branch is the one to watch when the rest of this is built. Turning
 * `INTL_ENABLED` on must replace it with a draft, not with silence: a foreign
 * amount that reaches the ordinary path is an amount whose currency mark gets
 * stripped on the way to `parseAmountToKobo`.
 */
function foreignRefusal(money: Parsed["money"], quote: Quote | undefined): string | null {
  switch (money.kind) {
    case "naira":
      return null;
    case "unsupported":
      return VOICE.currencyNotTaken(money.named);
    case "mixed":
      return VOICE.whichCurrency(money.currencies[0]!, money.currencies[1]!);
    case "foreign":
      /*
       * Let through only when the feature is on *and* a rate came with the
       * message. Both, because either alone is a way to price somebody's
       * work wrongly: with no rate there is nothing to convert at, and with
       * no flag the rest of the path — Pro gating, Paystack, the client's
       * page — is not there to receive it.
       *
       * The caller fetches the rate and has its own words for not having
       * one ("try again shortly"), so reaching here with the flag on and no
       * quote means something upstream skipped that. Refusing is the safe
       * end of that mistake: "$1,200" falling through to the naira reader
       * produces a confident, confirmable invoice for ₦1,200.
       */
      return env.INTL_ENABLED && quote && quote.currency === money.currency
        ? null
        : VOICE.notInThatCurrency(INFO[money.currency].many);
  }
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
      /*
       * The form is on their phone, so there is no typed question to repeat.
       *
       * This used to be `VOICE.helpIdle` — the whole "What I can do" menu,
       * which is what the caller above exists to avoid: it invites somebody
       * to wander off a form they are part-way through, and most of what it
       * lists needs the account that form is creating. Point at the form
       * instead, and at the way to do it by hand.
       */
      return lines(
        `Tap ${b("Set up Balans")} above to finish.`,
        "Or send your business name here and we will do it in the chat.",
      );
  }
}

/**
 * The question somebody is part-way through answering, if there is one.
 *
 * Null while the form is open: nothing has been asked in the chat, so there
 * is nothing to repeat, and a refused command should be one line rather than
 * a line plus instructions for a question nobody was asked.
 */
function pendingQuestion(state: State): string | null {
  return state === "onboarding:form" ? null : onboardingHelp(state);
}

/** Exported for the onboarding tests and the eventual bank-change flow (F17). */
export const _internal = { normalisePhone };
