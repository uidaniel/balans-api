/**
 * Where messages go: a script or the assistant.
 *
 * Every complaint about the bot "not being smart" traced back to one thing.
 * The reader in front of everything pushed conversation into a script: "you
 * fit help me remind Edidiong say he dey owe me?" became a payment request
 * for Edidiong and the reply was "How much is Edidiong Uwak paying?". The
 * assistant never saw it.
 *
 * So this checks routing across a wide spread of what people actually type,
 * rather than one screenshot at a time. Not part of `npm test`: it calls the
 * parser model (about ₦50 a run).
 *
 *   node --env-file=.env.local --experimental-strip-types src/parser/route-eval.ts
 *
 * "talk" means the assistant answers it. Anything else is the intent that
 * must run. Where two are fine, both are listed.
 */

import { parseMessage } from "./parse.ts";
import { asCommand } from "./commands.ts";

const TODAY = { y: 2026, m: 10, d: 14 };
type Want = string | string[];

const CASES: [string, Want][] = [
  /* -- Chasing a client: always the assistant ----------------------------- */
  ["you fit help me remind edidiong uwak say he dey owe me?", "talk"],
  ["remind Tunde to pay", "talk"],
  ["can you remind Kemi about the money", "talk"],
  ["abeg chase Zenith for me", "talk"],
  ["tell Joshua to pay me", "talk"],
  ["send Tunde a reminder", "talk"],
  ["how do I remind a client", "talk"],
  ["Edidiong never pay me o", "talk"],
  ["Tunde has been owing me since last month what do I do", "talk"],
  ["this Sole Capsule people no wan pay", "talk"],
  ["my client is not responding", "talk"],
  ["can you message my client for me", "talk"],
  ["help me tell pysavant to balance me", "talk"],
  ["nudge Joshua", "talk"],

  /* -- Questions about their own books ------------------------------------- */
  ["why hasn't Tunde paid?", "talk"],
  ["has Edidiong seen the invoice?", ["talk", "status"]],
  ["did Kemi open my invoice", ["talk", "status"]],
  ["how much does Joshua owe me", ["talk", "debtors", "status"]],
  ["which client owes me the most", ["talk", "debtors"]],
  ["how much have I made since I started", ["talk", "summary"]],
  ["what's my biggest invoice", "talk"],
  ["when was invoice 3 due", ["talk", "status"]],
  ["how many invoices have I sent", ["talk", "summary"]],
  ["who paid me last", "talk"],
  ["is pysavant late", ["talk", "status"]],
  ["wetin Edidiong still owe me", ["talk", "debtors", "status"]],
  ["na how much I don make this year", ["talk", "summary"]],
  ["what did I charge Sole Capsule", "talk"],
  ["how much was the last invoice I sent", "talk"],

  /* -- How Balans works ---------------------------------------------------- */
  ["how do I add VAT", "talk"],
  ["can I send invoice in dollars", "talk"],
  ["can my client pay with card", "talk"],
  ["how do clients pay me", "talk"],
  ["do you charge any fee", "talk"],
  ["is there a limit to how many invoices I can send", "talk"],
  ["how do I delete an invoice", "talk"],
  ["can I add my logo", "talk"],
  ["what happens when the client pays", "talk"],
  ["how do I know when someone has paid", "talk"],
  ["can I invoice someone without their email", "talk"],
  ["how do I split payment into parts", "talk"],
  ["how does the deposit thing work", "talk"],
  ["can I edit an invoice I already sent", "talk"],
  ["can I send a receipt", "talk"],
  ["does the client get notified", "talk"],
  ["what's the difference between a quote and an invoice", "talk"],
  ["can I schedule an invoice for next month", "talk"],
  ["what is pro", ["talk", "upgrade"]],
  ["is pro worth it", ["talk", "upgrade"]],

  /* -- Small talk ---------------------------------------------------------- */
  ["hey bro", "talk"],
  ["hwfa", "talk"],
  ["hi", "talk"],
  ["hello boss", "talk"],
  ["good evening ma", "talk"],
  ["how are you", "talk"],
  ["how you dey", "talk"],
  ["what's up", "talk"],
  ["thanks", "talk"],
  ["thank you so much bro", "talk"],
  ["you too much", "talk"],
  ["God bless you", "talk"],
  ["na wa o", "talk"],
  ["lol", "talk"],
  ["ok", "talk"],
  ["alright", "talk"],
  ["no", "talk"],
  ["who are you", "talk"],
  ["are you a bot", "talk"],
  ["are you human", "talk"],
  ["who built you", "talk"],
  ["what's your name", "talk"],
  ["I love this app", "talk"],
  ["you're too slow", "talk"],
  ["you no sabi anything", "talk"],
  ["this app is useless", "talk"],
  ["I need help", "talk"],
  ["help me", "talk"],
  ["good night", "talk"],

  /* -- Dropping what the bot is working on -------------------------------- */
  ["abeg forget am", "talk"],
  ["i'm not sending invoice again bro", "talk"],
  ["never mind", "talk"],

  /* -- Off topic ----------------------------------------------------------- */
  ["what's the weather today", "talk"],
  ["tell me a joke", "talk"],
  ["who won the match yesterday", "talk"],
  ["write a poem for my girlfriend", "talk"],
  ["how do I cook jollof rice", "talk"],
  ["can you lend me money", "talk"],
  ["send me 5k", "talk"],
  ["I want to borrow money", "talk"],

  /* -- Trouble ------------------------------------------------------------- */
  ["my client said the link is not working", "talk"],
  ["I didn't receive my money", "talk"],
  ["the client paid but it still shows unpaid", "talk"],
  ["I was charged twice", "talk"],
  ["how do I contact support", "talk"],
  ["my bank details are wrong", ["talk", "settings"]],
  ["I want to delete my account", ["talk", "settings"]],

  /* -- Making something: must stay a script -------------------------------- */
  ["Invoice Tunde 20k for logo, due Friday", "create_invoice"],
  ["bill Zenith Homes 1.5m for interior renders", "create_invoice"],
  ["abeg invoice Chioma 45k for hotel", "create_invoice"],
  ["send invoice to Kemi 100k website", "create_invoice"],
  ["I want to invoice Joshua 600k for app development", "create_invoice"],
  ["create an invoice for Sole Capsule, 133k, branding", "create_invoice"],
  ["make invoice for Edidiong 50k photography", "create_invoice"],
  ["Tunde owes me 20k for the logo, invoice him", "create_invoice"],
  ["invoice Mr Ade 350k website redesign and 40k hosting, 50% deposit", "create_invoice"],
  ["new invoice", ["create_invoice", "talk"]],
  ["I wan bill person", ["create_invoice", "talk"]],
  ["invoice tunde", "create_invoice"],
  ["I need to send an invoice to Zenith for 2m", "create_invoice"],
  ["quote Mr Ade 350k for website", "create_quote"],
  ["send a quote to Zenith for 2m renovation", "create_quote"],
  ["make quotation for Kemi 80k", "create_quote"],
  ["request 50k from Tunde for deposit", "payment_request"],
  ["collect 20k from Kemi", "payment_request"],

  /* -- Doing something to one already sent --------------------------------- */
  ["who owes me", "debtors"],
  ["who dey owe me", "debtors"],
  ["show me my unpaid invoices", ["debtors", "talk"]],
  ["how much did I make this month", ["summary", "talk"]],
  ["summary for September", "summary"],
  ["how did I do last month", ["summary", "talk"]],
  ["status of invoice 3", "status"],
  ["has Tunde paid?", ["status", "talk"]],
  ["check invoice 5", "status"],
  ["Tunde paid invoice 4", "record_payment"],
  ["mark invoice 2 paid", "record_payment"],
  ["Edidiong don pay invoice 3", "record_payment"],
  ["I received payment for invoice 5", ["record_payment", "talk"]],
  ["cancel invoice 4", "cancel_document"],
  ["resend invoice 3", "resend_document"],
  ["send invoice 4 again", ["resend_document", "talk"]],
  ["edit invoice 3", "edit_document"],
  ["change the amount on invoice 4", ["edit_document", "talk"]],
  ["convert quote 1", "convert_quote"],
  ["change my bank account", "settings"],
  ["update my business name", "settings"],
  ["settings", "settings"],
  ["upgrade to pro", "upgrade"],
  ["I want pro", ["upgrade", "talk"]],
  ["change my invoice design", "templates"],
  ["stop reminders for invoice 4", "stop_reminders"],
  ["stop reminding Tunde", ["stop_reminders", "talk"]],
  ["refer a friend", "referral"],
  ["help", "help"],
  ["menu", "help"],
  ["/", "help"],
];

/** Where the conversation machine sends it, at idle. Mirrors machine.ts. */
const HELP_WORDS = /^(help|menu|\/)$/i;
function route(intent: string, text: string): string {
  if (["question", "social", "unknown"].includes(intent)) return "talk";
  // Typed yes or no with nothing waiting is talk; a tapped one is the button.
  if (intent === "confirm" || intent === "reject") return "talk";
  if (intent === "help" && !HELP_WORDS.test(text.trim()) && !asCommand(text)) return "talk";
  return intent;
}

let passed = 0;
const misses: string[] = [];
const batch = 4;
for (let i = 0; i < CASES.length; i += batch) {
  await Promise.all(
    CASES.slice(i, i + batch).map(async ([text, want]) => {
      const r = await parseMessage(text, { today: TODAY });
      const got = r.ok ? route(r.parsed.intent, text) : `failed:${r.reason}`;
      const ok = (Array.isArray(want) ? want : [want]).includes(got);
      if (ok) passed += 1;
      else misses.push(`✖ "${text}" → ${got}${r.ok ? ` (${r.parsed.intent}, ${r.parsed.source})` : ""}, wanted ${[want].flat().join(" or ")}`);
    }),
  );
}
console.log(misses.sort().join("\n"));
console.log(`\n${passed}/${CASES.length} routed right`);
