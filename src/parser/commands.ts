/**
 * The fast path (PRD F3).
 *
 * "A deterministic fast path handles exact commands without calling the
 * model." Three reasons it matters, in order of how much they cost:
 *
 *   1. "yes" is the most frequent message the bot will ever receive, and it is
 *      the one where a model getting it wrong sends a real invoice to a real
 *      client. There is no reading of "yes" worth a model call.
 *   2. It is free, and instant.
 *   3. When the model is down, the whole of this still works — which is what
 *      PRD section 15 promises.
 *
 * Nothing here is fuzzy. A phrase either is one of these or it is not, and
 * anything else goes to the model rather than being half-matched.
 */

import type { Intent } from "./schema.ts";

export type Command = { intent: Intent; documentNumber?: number; social?: SocialKind };

/**
 * Slash commands.
 *
 * WhatsApp has no autocomplete, so "/" cannot pop up a menu the way it does in
 * Slack. What it can do is answer: typing "/" on its own returns the list, and
 * every entry on that list works typed out in full.
 *
 * The point is discoverability. Somebody who has never used this has no idea
 * that "who owes me" is a thing they can say, and a product whose entire
 * surface is a text box has to tell them. "/" is the one convention people
 * already try when they are looking for that.
 *
 * Every one of these also works without the slash, because most people will
 * just type the word.
 */
const SLASH: Record<string, Intent> = {
  invoice: "create_invoice",
  bill: "create_invoice",
  quote: "create_quote",
  collect: "payment_request",
  request: "payment_request",
  owed: "debtors",
  debtors: "debtors",
  summary: "summary",
  status: "status",
  settings: "settings",
  design: "templates",
  designs: "templates",
  template: "templates",
  templates: "templates",
  pro: "upgrade",
  upgrade: "upgrade",
  help: "help",
  menu: "help",
  cancel: "reject",
  stop: "stop_reminders",
};

/** "/" on its own, or "/menu": the list of everything. */
const SLASH_MENU = /^\/(?:\s*|help|menu|commands?|\?)$/;

/**
 * Nigerian English and light Pidgin, because that is what people type.
 * "na so", "correct", "abeg" and "dey" are not decoration: leaving them out
 * means a model call for the most common message in the product.
 */
const EXACT: [RegExp, Intent][] = [
  [/^(y|ye|yes|yea|yeah|yep|yup|ok|okay|okey|sure|correct|confirm(?:ed)?|approve[d]?|go ahead|send it|send am|do it|proceed|na so|e correct|sharp|alright|right)$/, "confirm"],
  [/^(n|no|nope|nah|cancel|cancel it|stop|wrong|not correct|e no correct|abort|no o)$/, "reject"],
  [/^(help|menu|options|what can you do|what do you do|abeg help|how does this work|how e dey work)$/, "help"],
  [/^(who owes me|who owe me|who dey owe me|debtors|debtor|outstanding|unpaid|who never pay|owing)\??$/, "debtors"],
  [/^(status|my status|where we dey|any update)\??$/, "status"],
  [/^(summary|report|how much did i make|how far|my earnings|this month|total)\??$/, "summary"],
  [/^(settings|setting|my details|change bank|change my bank|update bank|my bank|account details)$/, "settings"],
  // Advertised on the landing page, so people will ask. Answered honestly
  // rather than steered into settings, which has nothing to do with it.
  [/^(templates?|invoice templates?|change (my )?(invoice |email )?templates?|design|invoice design)$/, "templates"],
  // F21: offered in the words that confirm a logo was saved, so it has to work.
  [/^(remove|delete|clear) (my )?logo$/, "remove_logo"],
  [/^(upgrade|go pro|pro|subscribe|premium|upgrade me)$/, "upgrade"],
  [/^(referral|refer|refer a friend|invite|invite a friend|my referral|referral code)$/, "referral"],
  [/^(stop reminders?|no more reminders?|stop reminding me|turn off reminders?|stop chasing)$/, "stop_reminders"],
  [/^(dashboard|my dashboard|web|website|link to dashboard)$/, "summary"],
];

/**
 * Somebody being a person rather than asking for something.
 *
 * Matched here, before any model call, because these are the cheapest
 * messages in the product to recognise and were getting the most expensive
 * possible answer: a round trip to a model that labelled them "unknown", and
 * then a reply explaining what this tool does to somebody who had just said
 * thank you.
 *
 * Four kinds, because one reply for all four would be barely better than
 * what it replaced. "Good morning" and "thanks" are not the same message and
 * do not want the same answer.
 *
 * Nigerian English throughout: "well done" is a greeting here and not praise,
 * "no wahala" and "you try" are acknowledgement, and somebody typing "thanks
 * boss" at one in the morning is the most likely message in this whole list.
 */
export type SocialKind = "thanks" | "greeting" | "praise" | "farewell";

const SOCIAL: [RegExp, SocialKind][] = [
  [
    /^(thanks?|thank you|thank u|tanks|thx|ty|thanks? (?:a lot|so much|boss|o+|jare|sir|ma)|much appreciated|appreciate(?:d| it| you)?|i appreciate|god bless(?: you)?|bless you|no wahala|you try|well done o)$/,
    "thanks",
  ],
  [
    /^(hi|hey|hello|helo|yo|sup|howfar|how far|good morning|good afternoon|good evening|morning|afternoon|evening|well done|hi there|hello there|greetings|salut)$/,
    "greeting",
  ],
  [
    /^(nice|nice one|very nice|this is nice|thats? nice|cool|great|lovely|beautiful|sweet|perfect|excellent|amazing|brilliant|love it|i love (?:this|it)|this is (?:nice|good|great|cool|sweet)|good (?:job|work)|well done (?:guys|team)|you guys try|na correct thing)$/,
    "praise",
  ],
  [
    /^(bye|goodbye|bye bye|good night|goodnight|night|later|see you|see ya|talk later|catch you later|i'?m off|thats? all|that'?s all for now|done for today)$/,
    "farewell",
  ],
];

/**
 * Which kind of pleasantry this is, or null when it is not one.
 *
 * Exported so the model path can reuse it: when the model labels something
 * "social" the machine still has to decide which of the four to answer with,
 * and two lists that could disagree is one list too many.
 */
export function socialKind(text: string): SocialKind | null {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[.!,?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s || s.length > 40) return null;
  for (const [re, kind] of SOCIAL) if (re.test(s)) return kind;
  return null;
}

/** "invoice 12" style commands, where the number is part of the instruction. */
const NUMBERED: [RegExp, Intent][] = [
  [/^cancel (?:invoice|quote|inv|doc|document) #?(\d{1,6})$/, "cancel_document"],
  [/^(?:resend|send again|share) (?:invoice|quote|inv|doc|document) #?(\d{1,6})$/, "resend_document"],
  [/^(?:status(?: of)?|check) (?:invoice|quote|inv|doc|document) #?(\d{1,6})\??$/, "status"],
  [/^convert (?:quote|qt) #?(\d{1,6})$/, "convert_quote"],
  [/^(?:invoice|quote|inv|doc|document) #?(\d{1,6}) status\??$/, "status"],
  [/^stop reminders? (?:for |on )?(?:invoice|inv|doc|document) #?(\d{1,6})$/, "stop_reminders"],
];

/**
 * Reads a message as a command, or returns null to send it on to the model.
 *
 * Deliberately strict: it matches the whole message, trimmed and stripped of
 * trailing punctuation, and nothing else. "yes send it to Tunde as well" is
 * not a confirmation, and treating it as one would send the wrong document.
 */
export function asCommand(text: string): Command | null {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[.!,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s || s.length > 60) return null;

  // "/" is a request for the list, not a command that does anything.
  if (SLASH_MENU.test(s)) return { intent: "help" };

  // Before the slash handling and before EXACT: "well done" is a greeting in
  // Nigerian English and must not fall through to anything that acts.
  const social = socialKind(s);
  if (social) return { intent: "social", social };

  if (s.startsWith("/")) {
    // "/invoice Tunde 20k" carries a sentence after the command, and the
    // sentence is the part that matters: strip the slash and read it whole.
    const [word = "", ...rest] = s.slice(1).split(" ");
    const intent = SLASH[word];
    if (!intent) return null;
    // A bare slash command is the command. One with arguments is a sentence.
    if (rest.length) return null;
    return { intent };
  }

  for (const [re, intent] of EXACT) {
    if (re.test(s)) return { intent };
  }

  for (const [re, intent] of NUMBERED) {
    const m = re.exec(s);
    if (m) return { intent, documentNumber: Number(m[1]) };
  }

  return null;
}
