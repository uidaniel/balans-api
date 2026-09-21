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

import { normalisePhone } from "../whatsapp/client.ts";

export type State =
  | "new"
  | "onboarding:business_name"
  | "onboarding:bank"
  | "onboarding:confirm_account"
  | "onboarding:email"
  | "onboarding:verify_email"
  | "onboarding:consent"
  | "idle"
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
};

/**
 * Work the caller must do. The machine decides *what* should happen; the caller
 * owns the side effects, which keeps this function pure and testable.
 */
export type Effect =
  | { type: "resolve_account"; bankQuery: string; accountNumber: string }
  | { type: "create_subaccount" }
  | { type: "send_email_code"; email: string }
  | { type: "verify_email_code"; email: string; code: string }
  | { type: "record_consent"; version: string }
  | { type: "show_help" };

export type Step = {
  replies: string[];
  next: State;
  context: Context;
  effects: Effect[];
};

export type Inbound = {
  text: string;
  profileName?: string;
};

/* -------------------------------------------------------------------------- */
/* Global commands                                                            */
/* -------------------------------------------------------------------------- */

const HELP = /^(help|menu|what can you do|abeg help)\b/i;
const CANCEL = /^(cancel|stop|start over|restart)\b/i;
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|hola|howfa|how far)\b/i;

const VOICE = {
  askBusinessName:
    "Welcome to Balans. What is your business called? This is the name your clients will see on every invoice.",
  askBank:
    "Thanks. Which bank do you use, and what is the account number? Send them together, like “GTBank 0123456789”.",
  askEmail:
    "Almost done. What email address should we send your receipts and copies to?",
  askCode: (email: string) => `We sent a 6-digit code to ${email}. What is it?`,
  askConsent:
    "Last thing. By continuing you accept our terms and privacy notice:\n" +
    "balans.ng/terms\nbalans.ng/privacy\n\nReply “I agree” to finish.",
  done:
    "You are set up. Send me a line like “Invoice Zenith Homes 350k for duplex 3D render, due Friday” and I will draft it for you.",
  helpIdle:
    "I handle quotes, invoices and payments.\n\n" +
    "Try: Invoice Tunde 20k for logo design, due Friday\n" +
    "Or ask: who owes me?",
  paused:
    "Your account is on hold while we review it. Payments on invoices you already sent still work. Email hello@balans.ng and a person will look at it.",
};

/* -------------------------------------------------------------------------- */

export function step(state: State, context: Context, msg: Inbound, consentVersion: string): Step {
  const text = msg.text.trim();

  // A paused account can still ask for help, and nothing else (section 5).
  if (state === "paused") {
    return { replies: [VOICE.paused], next: state, context, effects: [] };
  }

  // Commands come before the pending question, so nobody gets stuck.
  if (HELP.test(text)) {
    return {
      replies: [state === "idle" ? VOICE.helpIdle : onboardingHelp(state)],
      next: state,
      context,
      effects: [{ type: "show_help" }],
    };
  }

  if (CANCEL.test(text) && state.startsWith("onboarding")) {
    return {
      replies: ["No problem, we will start again.", VOICE.askBusinessName],
      next: "onboarding:business_name",
      context: {},
      effects: [],
    };
  }

  switch (state) {
    case "new":
      // Anything at all begins onboarding. A greeting is the common case, but
      // someone who opens with "invoice Tunde 20k" should not be told off:
      // take them through setup and their instruction still stands afterwards.
      return {
        replies: GREETING.test(text)
          ? [VOICE.askBusinessName]
          : ["Let us get you set up first, then I can do that.", VOICE.askBusinessName],
        next: "onboarding:business_name",
        context: {},
        effects: [],
      };

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

    case "idle":
      if (GREETING.test(text)) {
        return { replies: [VOICE.helpIdle], next: "idle", context, effects: [] };
      }
      // PRD-GAP: the parser (F3) turns this into a draft. Until it exists, say
      // so plainly rather than pretending to understand.
      return {
        replies: ["I cannot draft documents yet — that part is still being built."],
        next: "idle",
        context,
        effects: [],
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

function takeBusinessName(text: string, ctx: Context, msg: Inbound): Step {
  const name = text.replace(/\s+/g, " ").trim();

  if (name.length < 2 || name.length > 80) {
    return retry(
      "onboarding:business_name",
      ctx,
      "That does not look like a business name. Send the name your clients would recognise, like “Kemi Adeyemi Studio”.",
    );
  }

  return {
    replies: [`Got it — ${name}.`, VOICE.askBank],
    next: "onboarding:bank",
    context: { ...ctx, businessName: name, attempts: 0 },
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
      "I need a 10-digit account number. Send the bank and the number together, like “GTBank 0123456789”.",
    );
  }
  if (bank.length < 2) {
    return retry(
      "onboarding:bank",
      ctx,
      `Which bank is ${account} with? Send the bank name, like “GTBank”.`,
    );
  }

  return {
    replies: ["One moment, checking that account…"],
    next: "onboarding:confirm_account",
    context: { ...ctx, accountNumber: account, bankName: bank, attempts: 0 },
    // The caller resolves the name with the provider. We never take the user's
    // word for whose account it is (F17).
    effects: [{ type: "resolve_account", bankQuery: bank, accountNumber: account }],
  };
}

function confirmAccount(text: string, ctx: Context): Step {
  if (/^(yes|yeah|yep|correct|that is right|na me|ok|okay)\b/i.test(text)) {
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
  return retry(
    "onboarding:confirm_account",
    ctx,
    ctx.resolvedAccountName
      ? `Is ${ctx.resolvedAccountName} the right account? Reply yes or no.`
      : "Reply yes or no.",
  );
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function takeEmail(text: string, ctx: Context): Step {
  const email = text.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    return retry(
      "onboarding:email",
      ctx,
      "That does not look like an email address. Send it like you@yourbusiness.com.",
    );
  }
  return {
    replies: [VOICE.askCode(email)],
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
      replies: [],
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
      'The code is 6 digits. Send it, or reply "resend" for a new one.',
    );
  }

  // Whether it is right is the caller's business: only it can check the hash.
  // It moves the conversation on, or holds it here.
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
      replies: [VOICE.done],
      next: "idle",
      context: { ...ctx, attempts: 0 },
      effects: [{ type: "record_consent", version }],
    };
  }
  return retry(
    "onboarding:consent",
    ctx,
    "I need your agreement before we can create documents. Reply “I agree” to finish, or email hello@balans.ng with any question.",
  );
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
    replies.push("If this is not working, email hello@balans.ng and a person will set it up with you.");
  }
  return { replies, next: state, context: { ...ctx, attempts }, effects: [] };
}

function onboardingHelp(state: State): string {
  switch (state) {
    case "onboarding:business_name":
      return "I am setting up your account. Send the name your clients would recognise, like “Kemi Adeyemi Studio”. Reply “cancel” to start again.";
    case "onboarding:bank":
      return "Send your bank and account number together, like “GTBank 0123456789”. This is where your money will settle. Reply “cancel” to start again.";
    case "onboarding:confirm_account":
      return "Reply yes if that is your account, or no to send different details.";
    case "onboarding:email":
      return "Send an email address you can open now — we will send a code to it.";
    case "onboarding:verify_email":
      return "Send the 6-digit code from your email. Reply “cancel” to start again.";
    case "onboarding:consent":
      return "Read balans.ng/terms and balans.ng/privacy, then reply “I agree”.";
    default:
      return VOICE.helpIdle;
  }
}

/** Exported for the onboarding tests and the eventual bank-change flow (F17). */
export const _internal = { normalisePhone };
