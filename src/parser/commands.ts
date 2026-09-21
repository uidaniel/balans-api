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

export type Command = { intent: Intent; documentNumber?: number };

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
  [/^(upgrade|go pro|pro|subscribe|premium|upgrade me)$/, "upgrade"],
  [/^(referral|refer|refer a friend|invite|invite a friend|my referral|referral code)$/, "referral"],
  [/^(stop reminders?|no more reminders?|stop reminding me|turn off reminders?|stop chasing)$/, "stop_reminders"],
  [/^(dashboard|my dashboard|web|website|link to dashboard)$/, "summary"],
];

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

  for (const [re, intent] of EXACT) {
    if (re.test(s)) return { intent };
  }

  for (const [re, intent] of NUMBERED) {
    const m = re.exec(s);
    if (m) return { intent, documentNumber: Number(m[1]) };
  }

  return null;
}
