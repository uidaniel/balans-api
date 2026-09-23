/**
 * Corrections to a draft on screen (PRD F6 step 3).
 *
 * "User can confirm, reject, or correct in plain language ('make it 400k',
 * 'due next Friday'). Corrections update the draft and re-show the summary."
 *
 * Read here rather than by the model, for the same reason "yes" is: the draft
 * is already correct, and the only thing a correction can do is make it wrong.
 * A narrow reader that returns null for anything it is not sure about hands
 * the odd case to the model, which is the right trade when the common cases
 * are five fixed shapes.
 */

import { parseAmountToKobo } from "../../core/amount.ts";
import { resolveDueDate, type Civil } from "../../core/dates.ts";
import { COUNTED, SPREAD, countOf } from "./extract.ts";

export type Correction = {
  totalKobo?: number;
  /**
   * Lines to put on the end of the draft.
   *
   * The form holds five items and cannot hold a sixth, and every way of
   * adding one inside a WhatsApp Flow fights the format: there is no
   * repeating list, no way to redraw a screen in place, and at most two
   * tappable links on a screen. Typing has none of those limits, and the
   * sentence that creates an invoice has read several items since the
   * beginning — "logo 50k, website 250k" is two lines. This is the same
   * ability, pointed at a draft that already exists.
   */
  addLines?: { description: string; unitAmountKobo: number }[];
  /**
   * A line to take off, named the way somebody would name it.
   *
   * Either its number on the summary — "remove item 2" — or words out of
   * it, "remove the SEO line". Which one is decided here; finding it is the
   * machine's job, because only the machine has the draft.
   */
  removeLine?: { position: number } | { match: string };
  /**
   * Rewording a line that is already there, keeping its price.
   *
   * There was no way to say this, and the gap cost real money. "change the
   * commercial for opay to commercial for Opay Nigeria" went to the model,
   * which expressed it the only way the schema allowed — remove that line,
   * add a new one — and the new one carried no price, so it was dropped for
   * being half an item. The removal was not. A ₦2,500,000 line disappeared
   * off the draft and the total fell to ₦215,000, with nothing anywhere
   * saying a line had been deleted.
   *
   * `match` is words out of the line as they typed them; the machine finds
   * it, because only the machine holds the draft.
   */
  renameLine?: { match: string; to: string };
  dueDate?: Civil;
  /** The phrase, so the summary can echo how they said it. */
  duePhrase?: string;
  /**
   * A date for one part of the payment plan.
   *
   * "let the 50% deposit be due on Friday this week". The plan's dates were
   * worked out entirely from the issue date and the document's due date, so
   * there was nowhere for that sentence to land: the first part was always
   * "due now" and the draft came back looking exactly as it had — which
   * reads as the bot ignoring you, and is the thing that made this worth
   * building.
   *
   * `which` is resolved against the draft, because only the machine knows how
   * many parts there are: "the balance" is part two of a deposit and part
   * five of five instalments.
   */
  stageDue?: { which: "first" | "last" | number; date: Civil; phrase: string };
  clientName?: string;
  /**
   * Where the client's copy goes. Null takes the address off entirely.
   *
   * Everything else on a draft could be corrected and this could not, so
   * "change the email to uakdan209@gmail.com" — a sentence with exactly one
   * possible meaning — came back as "I did not catch that". A typo in an
   * address meant discarding the draft and writing the whole invoice again.
   */
  clientEmail?: string | null;
  description?: string;
  vatPercent?: number | null;
  depositPercent?: number | null;
  instalments?: number | null;
  passFeesToClient?: boolean;
};

/** Verbs that mean "replace this", not "add this". */
const CHANGE = String.raw`(?:make it|change it to|change to|change|set it to|set to|it(?:'| i)?s|its|should be|update to|no,? )`;

/**
 * The noise around a change, which carries no meaning of its own.
 *
 * Two shapes of it cost real money before they were read. "no make it 400k"
 * is a correction and not a rejection — the "no" is agreeing that the draft
 * is wrong — and it matched nothing at all, so the whole sentence went to the
 * model to be guessed at. And "make it 400k and due 1 Oct" joins two
 * corrections with a word: the date was taken off the end and the amount was
 * left sitting behind an "and" that no rule could step over, so the draft came
 * back with the new date and the old price. Half a correction is worse than
 * none, because it looks applied.
 */
const FILLER = String.raw`(?:(?:no|nope|nah|ok|okay|abeg|please|pls|actually|and|also|plus|then|sorry)\b[,;]?\s*)*`;

const CHANGE_VERB = String.raw`(?:make it|change it to|change to|set it to|set to|it should be|should be|update it to|update to)`;

const AMOUNT_ONLY = new RegExp(
  String.raw`^${FILLER}${CHANGE_VERB}?\s*${FILLER}(?:₦|n|ngn)?\s?(\d[\d,]*(?:\.\d+)?\s?[hkm]?)\s*(?:instead|abeg|please|o)?$`,
  "i",
);

const AMOUNT_LABELLED =
  /(?:amount|total|price|it|cost)\s+(?:should be|is|to)\s+(?:₦|n|ngn)?\s?(\d[\d,]*(?:\.\d+)?\s?[hkm]?)\b/i;

/**
 * Money as people write it: "100k", "₦250,000", "1.5m", "N20000".
 *
 * The naira prefix needs a word boundary in front of it. Without one, the
 * "n" of "design" was read as the currency: "add logo design 50k" came back
 * as an item called "logo desig".
 */
const MONEY = String.raw`(?:₦|\bngn|\bn)?\s?\d[\d,]*(?:\.\d+)?\s?[hkm]?`;

/**
 * "add SEO 100k", "also add hosting for 20000", "add another item: cards 5k".
 *
 * Only the opening words. What follows is split on "and" and commas and read
 * one line at a time, because "add SEO 100k and hosting 20k" is two items and
 * a single pattern would hand back "SEO 100k and hosting" as the description.
 */
const ADD_LINES = new RegExp(
  String.raw`\b(?:also\s+)?(?:add|include|put in|throw in)\s+` +
    String.raw`(?:(?:another|a|one more|an extra)\s+(?:item|line)s?\s*[:,-]?\s*)?`,
  "i",
);

/** One "something, some money" pair, with whatever joins them. */
const ONE_LINE = new RegExp(
  String.raw`^(.+?)\s*(?:\bfor\b|\bat\b|@|[:=-])?\s*(${MONEY})$`,
  "i",
);

/**
 * Taking a line off by name or by number.
 *
 * Read after the fixed options, so "remove the VAT" and "remove the deposit"
 * are long gone by the time this sees the message — they are answers to
 * different questions and each has its own rule above.
 */
const REMOVE_LINE =
  /\b(?:remove|delete|take off|take out|drop|cancel)\s+(?:the\s+)?(.+?)\s*(?:\bline\b|\bitem\b)?$/i;

/** "item 2", "line 3", "the 2nd one" — a position rather than a name. */
const BY_POSITION = /^(?:item|line|number|no\.?)?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s+one)?$/i;

/**
 * Naming one part of a payment plan.
 *
 * Every way somebody refers to a single instalment: the words the labels use
 * ("50% deposit", "Balance", "Part 2 of 3"), and the words people use instead.
 */
const STAGE =
  /\b(?:the\s+)?(?:(?:\d{1,3}\s*%\s*)?(deposit|upfront|down ?payment)|(balance|final|last)(?:\s+payment)?|(?:part|payment|instal?ment|milestone)\s*(\d{1,2})|(first|second|third|fourth|fifth)\s+(?:part|payment|instal?ment|milestone))/i;

/** The words that come before a date in "... be due on Friday". */
const STAGE_DUE = /\b(?:be\s+)?due\s*(?:on|by)?\s*:?\s*(.+)$/i;

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/**
 * An address, and the ways people put one on a draft.
 *
 * Deliberately loose about the verb and strict about the address: anything
 * shaped like an email is almost certainly meant as one, and there is nothing
 * else on an invoice it could be mistaken for. A bare address on its own line
 * counts, because that is what people send when they have been asked once.
 */
const EMAIL = String.raw`[^\s@]+@[^\s@]+\.[a-z]{2,}`;

/*
 * Three ways in, and a bare address on its own.
 *
 *   a verb and a preposition   “send it to x@y.com”, “use x@y.com”
 *   the noun                   “change the email to x@y.com”, “email: x@y”
 *   nothing at all             “x@y.com”, which is what people send when
 *                              they have already been asked once
 *
 * The trailing filler matters more than it looks: “use joshua@opay.com
 * instead” failed on the anchor alone, and a correction this reader half
 * understands is a correction it refuses outright.
 */
const SET_EMAIL = new RegExp(
  String.raw`(?:^|\b)(?:` +
    // a verb, with the noun optional: “send it to”, “change the email to”
    String.raw`(?:change|correct|fix|update|set|use|send|forward|cc)\s+(?:it|them)?\s*` +
    String.raw`(?:(?:the|his|her|their|client(?:'|’)?s?)\s+)?(?:e-?mail|mail|address)?\s*` +
    String.raw`(?:to|is|should be|for|:|=)?\s*` +
    String.raw`|` +
    // the noun on its own: “the email is”, “email:”
    String.raw`(?:(?:the|his|her|their|client(?:'|’)?s?)\s+)?(?:e-?mail|mail|address)\s*` +
    String.raw`(?:it|them)?\s*(?:to|is|should be|:|=)?\s*` +
    String.raw`|` +
    // or nothing: the address by itself
    String.raw`)(${EMAIL})(?:\s+(?:instead|please|pls|abeg|o|thanks))?\s*$`,
  "i",
);

/**
 * "change X to Y", where X is a line already on the invoice.
 *
 * Last of the rules, so every shape with a field name in it — the amount,
 * the date, the client, the description — has already been taken. What is
 * left saying "change ... to ..." is somebody renaming a line.
 */
const RENAME_LINE =
  /^(?:change|rename|correct|fix|update|edit)\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(.+)$/i;

/** "no email", "remove the email", "don't email it". */
const NO_EMAIL =
  /\b(?:no|remove|without|drop|take off|forget|cancel)\s+(?:the\s+)?e-?mail\b|\bdo\s?n(?:o|')?t\s+e-?mail\b/i;

const DUE = /\b(?:due|deadline|payable|pay(?:able)? by)\s*:?\s*(.+)$/i;
const DUE_CHANGE = new RegExp(String.raw`\b(?:${CHANGE})\s*due\s*:?\s*(.+)$`, "i");

/**
 * Changing who the document is for.
 *
 * A bare "for" used to be enough, and it is the wrong word to trust: in a
 * correction, "for" introduces the work at least as often as the person.
 * "make it 400k for the logo" renamed the client to "The Logo", and "20% for
 * the first milestone" renamed one to "The First Milestone" on a live draft.
 * What is left are phrases that can only mean a person.
 */
const CLIENT =
  /\b(?:(?:client|name|customer)\s+(?:should be|is|to)|it(?:'|’)?s for|send it to|bill it to)\s+([A-Za-z][A-Za-z0-9 .'&-]{1,60})$/i;

/**
 * What people call the thing being billed for.
 *
 * "Item" is what the form asks for now; "work" is what it used to ask for and
 * what most people type anyway. Both have to be read, and will have to keep
 * being read long after the form settles on one word — nobody changes their
 * vocabulary because a label changed.
 */
const WORK_FIELD = String.raw`(?:item|work|description|service|job|product|line)`;

/**
 * "correct the work, it is photography".
 *
 * A real message that came back as "I did not catch that". The old rule wanted
 * the field name and the verb side by side — "work is photography" — and
 * people do not write that way. Everything optional here is something that
 * message had and the rule could not step over: a verb in front, an article,
 * and a comma where the rule expected a space.
 */
const DESCRIPTION = new RegExp(
  String.raw`\b(?:correct|change|fix|update|edit|make)?\s*(?:the\s+)?${WORK_FIELD}\s*[,;:-]?\s*` +
    String.raw`(?:it(?:'|’)?s|it is|its|should be|shd be|is|to|as|=)\s+(.+)$`,
  "i",
);

/** "item: photography" — a label and a value, with no verb between them. */
const DESCRIPTION_LABELLED = new RegExp(String.raw`^(?:the\s+)?${WORK_FIELD}\s*[:=]\s*(.+)$`, "i");

/** The old shape, kept because "for" and "it's for" are not field names. */
const DESCRIPTION_FOR = /\b(?:for|it(?:'|’)?s for)\s+(?:should be|is)\s+(.+)$/i;

const ADD_VAT = /\b(?:add|include|with|plus)\s+vat(?:\s*(?:at\s*)?(\d{1,2}(?:\.\d)?)\s*%)?/i;
const NO_VAT = /\b(?:no|remove|without|drop|take off)\s+(?:the\s+)?vat\b/i;
const DEPOSIT = /\b(?:(\d{1,3})\s*%\s*(?:deposit|upfront|down)|(?:deposit|upfront)\s*(?:of\s*)?(\d{1,3})\s*%)\b/i;
const NO_DEPOSIT = /\b(?:no|remove|without|drop)\s+(?:the\s+)?deposit\b/i;
const NO_INSTALMENTS =
  /\b(?:no|remove|without|drop|forget|cancel)\s+(?:the\s+)?(?:instal|install|milestone|payment plan)\w*\b|\b(?:one|1|single|full)\s+payments?\b/i;
const PASS_FEES = /\b(?:client|customer|they|them)\s+(?:should\s+|will\s+|go\s+|dey\s+)?pays?\s+(?:the\s+)?(?:fees?|charges?)\b/i;
const NO_PASS_FEES = /\bi(?:'| a)?ll?\s+pay\s+(?:the\s+)?(?:fees?|charges?)\b|\bi\s+pay\s+(?:the\s+)?fees?\b/i;

const VAT_DEFAULT = 7.5;

/**
 * Reads a message as a change to the draft, or returns null.
 *
 * Several things can change at once — "make it 400k, due next Friday" is one
 * message — so every rule is tried and the result is whatever they matched.
 */
export function readCorrection(text: string, today: Civil): Correction | null {
  const s = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!s || s.length > 200) return null;

  const out: Correction = {};
  let rest = s;

  /*
   * A date for one part of the plan, before the document's own date.
   *
   * Both start from the word "due", and the document rule takes everything
   * after it — so "let the 50% deposit be due on Friday" would set the
   * invoice's date and quietly drop the part it was actually about. This runs
   * first and only fires when a part is named, which the document rule never
   * does.
   */
  const stage = STAGE.exec(rest);
  if (stage) {
    const when = STAGE_DUE.exec(rest.slice(stage.index + stage[0]!.length));
    const resolved = when ? resolveDueDate(when[1]!, today) : null;
    if (resolved) {
      const ordinal = stage[4] ? ORDINALS.indexOf(stage[4].toLowerCase()) + 1 : 0;
      out.stageDue = {
        which: stage[1]
          ? "first"
          : stage[2]
            ? "last"
            : stage[3]
              ? Number(stage[3])
              : ordinal || "first",
        date: resolved.date,
        phrase: when![1]!.trim(),
      };
      rest = tidy(rest.slice(0, stage.index));
    }
  }

  /* The date next: it owns everything after "due", which would otherwise be
     read as a description. ------------------------------------------------- */
  const dueMatch = out.stageDue ? null : (DUE_CHANGE.exec(rest) ?? DUE.exec(rest));
  if (dueMatch) {
    const resolved = resolveDueDate(dueMatch[1]!, today);
    if (resolved) {
      out.dueDate = resolved.date;
      out.duePhrase = dueMatch[1]!.trim();
      rest = tidy(rest.slice(0, dueMatch.index));
    }
  }

  /* Options, each a fixed phrase. ------------------------------------------ */
  if (NO_VAT.test(rest)) {
    out.vatPercent = null;
    rest = rest.replace(NO_VAT, "").trim();
  } else {
    const vat = ADD_VAT.exec(rest);
    if (vat) {
      out.vatPercent = vat[1] ? Number(vat[1]) : VAT_DEFAULT;
      rest = rest.replace(ADD_VAT, "").trim();
    }
  }

  if (NO_DEPOSIT.test(rest)) {
    out.depositPercent = null;
    rest = rest.replace(NO_DEPOSIT, "").trim();
  } else {
    const deposit = DEPOSIT.exec(rest);
    if (deposit) {
      out.depositPercent = Number(deposit[1] ?? deposit[2]);
      rest = rest.replace(DEPOSIT, "").trim();
    }
  }

  /*
   * A deposit and instalments are two answers to one question.
   *
   * So asking for either clears the other. Without that, "actually make it 3
   * payments" would leave an earlier 50% deposit in place, and `shapeFor`
   * prefers the deposit — the draft would come back showing a split the user
   * had just replaced.
   */
  if (NO_INSTALMENTS.test(rest)) {
    out.instalments = null;
    rest = rest.replace(NO_INSTALMENTS, "").trim();
  } else {
    for (const re of [SPREAD, COUNTED]) {
      const m = re.exec(rest);
      const n = m ? countOf(m[1]) : null;
      if (n === null) continue;
      out.instalments = n;
      out.depositPercent = null;
      rest = rest.replace(re, "").trim();
      break;
    }
  }
  if (out.depositPercent != null) out.instalments = null;

  if (NO_PASS_FEES.test(rest)) {
    out.passFeesToClient = false;
    rest = rest.replace(NO_PASS_FEES, "").trim();
  } else if (PASS_FEES.test(rest)) {
    out.passFeesToClient = true;
    rest = rest.replace(PASS_FEES, "").trim();
  }

  rest = tidy(rest);

  /* Whatever is left may name the client or the work. ---------------------- */
  if (rest) {
    const described =
      DESCRIPTION_LABELLED.exec(rest) ?? DESCRIPTION.exec(rest) ?? DESCRIPTION_FOR.exec(rest);
    if (described) {
      const d = clean(described[1]!);
      if (d) {
        out.description = d;
        rest = tidy(rest.slice(0, described.index));
      }
    } else {
      const client = CLIENT.exec(rest);
      if (client) {
        const name = clean(client[1]!);
        // Names are short. Anything longer is a sentence we misread.
        if (name && name.split(" ").length <= 5) {
          out.clientName = name;
          rest = tidy(rest.slice(0, client.index));
        }
      }
    }
  }

  /*
   * The address, before anything that reads names or work.
   *
   * "send it to daniel@x.com" would otherwise be read by the client rule as
   * a person called "Daniel@x.com", and the draft would come back addressed
   * to an email address.
   */
  if (NO_EMAIL.test(rest)) {
    out.clientEmail = null;
    rest = tidy(rest.replace(NO_EMAIL, ""));
  } else {
    const email = SET_EMAIL.exec(rest);
    if (email) {
      out.clientEmail = email[1]!.toLowerCase();
      rest = tidy(rest.slice(0, email.index));
    }
  }

  /*
   * Adding and removing whole lines.
   *
   * After the fixed options, so "remove the VAT" is already accounted for,
   * and before the description and amount rules, which would otherwise read
   * "add SEO 100k" as a new price for the first line.
   */
  const adding = ADD_LINES.exec(rest);
  if (adding) {
    const after = rest.slice(adding.index + adding[0]!.length).trim();
    /*
     * A comma only separates items when a space follows it. Without that,
     * "include photography for N75,000" was split down the thousands
     * separator into "photography for N75" and "000", and the whole message
     * fell through to the model.
     */
    const parts = after.split(/\s*,\s+|\s+and\s+/i).filter(Boolean);
    const lines: { description: string; unitAmountKobo: number }[] = [];

    for (const part of parts) {
      const m = ONE_LINE.exec(part.trim());
      const kobo = m ? parseAmountToKobo(m[2]!) : null;
      const description = m ? clean(m[1]!) : "";
      // Every part or none. Half of "add SEO 100k and make it urgent" is an
      // item nobody asked for, priced at whatever the sentence ended with.
      if (!description || kobo === null || kobo <= 0) {
        lines.length = 0;
        break;
      }
      lines.push({ description, unitAmountKobo: kobo });
    }

    if (lines.length) {
      out.addLines = lines;
      rest = tidy(rest.slice(0, adding.index));
    }
  }

  if (!out.addLines) {
    const removing = REMOVE_LINE.exec(rest);
    if (removing) {
      const what = clean(removing[1]!) ?? "";
      const position = BY_POSITION.exec(what);
      if (position) {
        out.removeLine = { position: Number(position[1]) };
        rest = tidy(rest.slice(0, removing.index));
      } else if (what && what.split(" ").length <= 6) {
        out.removeLine = { match: what };
        rest = tidy(rest.slice(0, removing.index));
      }
    }
  }

  /* Then the amount, which is the change that matters most. ---------------- */
  const labelled = AMOUNT_LABELLED.exec(rest);
  const bare = labelled ? null : AMOUNT_ONLY.exec(rest);
  const amountText = labelled?.[1] ?? bare?.[1];
  if (amountText) {
    const kobo = parseAmountToKobo(amountText);
    // A bare number under ₦1,000 is far more likely a quantity or a typo than
    // a total; the limits reject it anyway, so asking is better than guessing.
    if (kobo !== null && kobo >= 1_000_00) {
      out.totalKobo = kobo;
      rest = "";
    }
  }

  /*
   * Everything, or nothing.
   *
   * This is the rule the file was missing, and the one that did the damage.
   * Each rule above cuts its own phrase out and the leftovers fall through to
   * the next, so a message this reader only half understood still came back
   * looking like an answer. Sent to a ₦30,000 draft for Temi:
   *
   *   "make it 200k and break it down in two milestones, 20% for the first
   *    milestone"
   *
   * it read the two milestones, lost the ₦200,000 because the amount rule is
   * anchored and there were words either side of it, ignored the 20%, and
   * then handed "for the first milestone" to the client rule. The draft came
   * back addressed to "The First Milestone", still priced at ₦30,000, and
   * split into two equal halves nobody asked for. Three fields wrong, and no
   * sign anywhere that anything had gone wrong.
   *
   * So a leftover is now a refusal. Text this reader cannot account for means
   * it did not understand the message, and a message it did not understand
   * goes to the model with the draft attached — which can read all four parts
   * of that sentence at once. Being certain is the only thing a regex has
   * over a model, and a regex that guesses has nothing.
   */
  /*
   * Renaming a line, which is the last thing this reader tries.
   *
   * Only reached when nothing above claimed the sentence, so "change the
   * amount to 400k" and "change the client to Daniel" are long gone. What
   * survives to here is two pieces of text either side of "to", which on an
   * invoice means a line being reworded.
   */
  if (!Object.keys(out).length) {
    const renaming = RENAME_LINE.exec(rest);
    if (renaming) {
      const from = clean(renaming[1]!);
      const to = clean(renaming[2]!);
      if (from && to && from.toLowerCase() !== to.toLowerCase()) {
        out.renameLine = { match: from, to };
        rest = "";
      }
    }
  }

  if (unexplained(rest)) return null;

  return Object.keys(out).length ? out : null;
}

/**
 * Strips the joins and the punctuation a clause leaves behind.
 *
 * Every rule here works by cutting its own phrase out of the message, which
 * leaves the word that joined it to the next one. A trailing "and" is enough
 * to stop the amount rule matching, and the failure is silent.
 */
const tidy = (s: string): string =>
  s
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .replace(/^(?:and|also|plus|then)\b[,;]?\s*/i, "")
    .replace(/[,;]?\s*\b(?:and|also|plus|then)$/i, "")
    .trim();

/**
 * What is left once the words that carry no content are taken out.
 *
 * Every rule above cuts out the phrase it matched and leaves the scaffolding:
 * "make it 3 payments" becomes "make it" once the plan is read, and that is
 * not a message anybody failed to understand. What matters is whether
 * anything with meaning in it survived — a price, a name, a percentage, a
 * word like "milestone" — because that is the part that was about to be
 * thrown away silently.
 *
 * Deliberately a list of noise rather than a list of meaning. A word nobody
 * thought about ends up counting as content, which costs a model call; the
 * other way round it would end up ignored, which costs a wrong invoice.
 */
const NOISE =
  /\b(?:no|nope|nah|ok|okay|abeg|please|pls|actually|sorry|and|also|plus|then|instead|now|make|makes|change|changed|set|update|correct|fix|edit|put|do|split|break|down|into|in|it|this|that|the|a|an|to|be|been|should|shd|is|are|was|for|of|on|at|as|so|just|abi|na|invoice|quote|draft|document|bill|add|adds|remove|delete|include|drop|let|lets|have|has|want|wants|i|me|my|we|us|email|e-mail|mail|address|send|sent|copy|cc)\b/gi;

const unexplained = (rest: string): boolean =>
  tidy(rest).replace(NOISE, "").replace(/[^a-z0-9]+/gi, "") !== "";

const clean = (s: string): string | null => {
  const t = s.trim().replace(/^["'“]|["'”]$/g, "").replace(/[,;:]+$/, "").trim();
  return t && t.length <= 200 ? t : null;
};
