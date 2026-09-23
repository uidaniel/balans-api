/**
 * Native WhatsApp commands and ice breakers.
 *
 * This is the thing that makes "/" pop up a real list above the keyboard, with
 * a name and a description for each entry, and puts the "Try these commands to
 * get started" chips on the business profile. It is configuration on the phone
 * number, not a message — WhatsApp renders it client-side, so it costs nothing
 * and appears before the user has sent anything at all.
 *
 * That last part is why it matters more than a text menu. Somebody who has
 * just been handed a number has no idea what to type; a help message only
 * helps once they have thought of asking for help.
 *
 *   npm run commands            show what is configured
 *   npm run commands -- --push  write this configuration
 */

import { env, require_ } from "../config.ts";

/**
 * The commands, as WhatsApp shows them.
 *
 * Meta's limits: at most 30, the name at most 32 characters with no spaces or
 * slash, the description at most 256. The descriptions are written for
 * somebody who has never seen the product, because that is exactly who reads
 * them.
 */
export const COMMANDS: { command_name: string; command_description: string }[] = [
  { command_name: "invoice", command_description: "Bill a client and get a payment link" },
  { command_name: "quote", command_description: "Send a quote before the work starts" },
  { command_name: "collect", command_description: "Ask someone for money, no invoice needed" },
  { command_name: "owed", command_description: "See who still owes you" },
  { command_name: "summary", command_description: "See how this month went" },
  { command_name: "status", command_description: "Check whether one invoice is paid" },
  { command_name: "settings", command_description: "Your business name, payout bank and due days" },
  { command_name: "design", command_description: "Choose how your invoices look" },
  { command_name: "pro", command_description: "Unlimited invoices and a lower fee" },
  { command_name: "help", command_description: "What I can do" },
];

/**
 * Ice breakers: the tappable suggestions above an empty chat.
 *
 * At most four, 80 characters each. These are sentences rather than commands
 * on purpose — the product's real interface is a sentence, and a first-time
 * user tapping one learns that they can simply say what they want.
 *
 * All four are written for a stranger, because only a stranger ever sees
 * them: WhatsApp shows ice breakers above an *empty* chat, so the person
 * reading them has never sent us anything. "Who owes me?" and "How did I do
 * this month?" were two of the four, and both answer with nothing — there
 * are no debtors and no month behind somebody who has not signed up. Two
 * slots in four spent proving the product is empty.
 *
 * So: one that starts setup, one that shows the trick before anybody has
 * committed to anything, and two that answer the questions people have
 * before they will do either. The money one is there because in Nigeria it
 * is the first question about anything touching a bank account, and the
 * people who will not ask it out loud are the ones who quietly leave.
 *
 * No emoji on any of them, which is not a style choice. Meta replaces every
 * emoji in an ice breaker with U+FFFD, the replacement character — proved by
 * writing "👋 Set me up" as correct UTF-8 and reading back "\ufffd Set me
 * up", and again with two emoji from the basic plane, which fare no better.
 * So a waving hand here is a black diamond on a stranger's first screen.
 */
export const PROMPTS: string[] = [
  "Set me up",
  "Invoice Tunde 20k for logo design, due Friday",
  "How does Balans work?",
  "Is my money safe?",
];

function url(path: string): string {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${path}`;
}

type Configured = {
  enable_welcome_message?: boolean;
  commands?: { command_name: string; command_description: string }[];
  prompts?: string[];
};

export async function readConfiguration(): Promise<Configured> {
  require_("WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN");
  const res = await fetch(url(`${env.WA_PHONE_NUMBER_ID}?fields=conversational_automation`), {
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
  });
  const body = (await res.json()) as {
    conversational_automation?: Configured;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.conversational_automation ?? {};
}

export async function writeConfiguration(): Promise<void> {
  require_("WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN");

  const res = await fetch(url(`${env.WA_PHONE_NUMBER_ID}/conversational_automation`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Meta then sends a webhook the first time somebody opens the chat, so
      // the bot can introduce itself before they have typed anything.
      enable_welcome_message: true,
      commands: COMMANDS,
      prompts: PROMPTS,
    }),
  });

  const body = (await res.json()) as { success?: boolean; error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--push")) {
      await writeConfiguration();
      console.log("configuration written\n");
    }

    const current = await readConfiguration();
    console.log("welcome message:", current.enable_welcome_message ? "on" : "off");
    console.log(`\ncommands (${current.commands?.length ?? 0}):`);
    for (const c of current.commands ?? []) {
      console.log(`  /${c.command_name.padEnd(10)} ${c.command_description}`);
    }
    console.log(`\nice breakers (${current.prompts?.length ?? 0}):`);
    for (const p of current.prompts ?? []) console.log(`  ${p}`);

    if (!process.argv.includes("--push") && !current.commands?.length) {
      console.log("\nNothing configured. Run with --push to write it.");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
