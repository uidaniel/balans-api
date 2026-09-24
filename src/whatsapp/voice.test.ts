/**
 * The house style, enforced.
 *
 * Every message the bot sends opens with exactly one emoji, chosen for what
 * that message is. The value is in a thread: fifteen grey bubbles all look the
 * same, and the first character of each is what lets somebody find the receipt
 * or the warning without reading them all.
 *
 * It is a test rather than a note in a comment because copy is written one
 * line at a time, months apart, and a convention nothing checks is a
 * convention that lasts until the next hurry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { VOICE } from "../conversation/machine.ts";
import { FLOWS } from "./flows/definitions.ts";
import * as reports from "../documents/reports.ts";
import * as summary from "../documents/summary.ts";
import * as notify from "../payments/notify.ts";
import * as settings from "../settings/messages.ts";
import * as billing from "../billing/messages.ts";
import * as alerts from "../settings/alerts.ts";

const OPENS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;
const EMOJI = /\p{Extended_Pictographic}/gu;

const TODAY = { y: 2026, m: 9, d: 21 };
const D = (n: number) => ({ y: 2026, m: 9, d: n });
const URL_ = "https://payment.balans.ng";

const draft = {
  type: "invoice",
  clientName: "Zenith Homes",
  totalKobo: 5000000,
  lines: [{ description: "Renders", qty: 1, unitAmountKobo: 5000000 }],
  dueDate: D(30),
  subtotalKobo: 5000000,
  vatKobo: 0,
} as never;

const notice = {
  userId: "u",
  documentType: "invoice",
  documentNumber: 3,
  clientName: "Zenith",
  paidKobo: 5000000,
  totalKobo: 5000000,
  amountPaidKobo: 5000000,
  fullyPaid: true,
  method: "CARD",
};

const account = { bankName: "GTBank", last4: "6789", accountName: "ADA" } as never;
const debt = { number: 3, clientName: "Zenith", outstandingKobo: 5000000, dueDate: D(10), publicToken: "t" };
const doc = {
  number: 3,
  type: "invoice",
  clientName: "Zenith",
  status: "sent",
  totalKobo: 5000000,
  paidKobo: 0,
  dueDate: D(30),
  sentAt: new Date("2026-09-21T09:00:00Z"),
  viewedAt: null,
  paidAt: null,
  publicToken: "t",
};
const period = { label: "September", from: D(1), to: D(30) };

/**
 * Every message, including the branches.
 *
 * The empty cases are here on purpose: "no debtors" and "no reminders to
 * stop" are written in a different place from their populated twins, and are
 * exactly the ones that get forgotten.
 */
const messages: [string, () => string][] = [
  ["debtors, owed", () => reports.debtorsMessage({ rows: [debt], totalKobo: 5000000, more: 0, moreKobo: 0 } as never, TODAY)],
  ["debtors, none", () => reports.debtorsMessage({ rows: [], totalKobo: 0, more: 0, moreKobo: 0 } as never, TODAY)],
  ["status, unpaid", () => reports.statusMessage(doc as never, TODAY, URL_)],
  ["status, paid", () => reports.statusMessage({ ...doc, paidKobo: 5000000, status: "paid" } as never, TODAY, URL_)],
  ["not found by number", () => reports.notFoundMessage({ number: 9 })],
  ["not found by client", () => reports.notFoundMessage({ clientName: "Tunde" })],
  ["summary", () => reports.summaryMessage({ period, invoicedKobo: 5000000, documents: 4, paidKobo: 2000000, outstandingKobo: 3000000, overdueKobo: 1000000, topClients: [{ name: "Zenith", paidKobo: 2000000 }] } as never)],
  ["summary, a quiet month", () => reports.summaryMessage({ period, invoicedKobo: 0, documents: 0, paidKobo: 0, outstandingKobo: 0, overdueKobo: 0, topClients: [] } as never)],
  ["plan limit reached", () => reports.limitReachedMessage(3, 3, { y: 2026, m: 9, d: 23 })],
  ["cancelled", () => reports.cancelledMessage({ number: 3, type: "invoice", clientName: "Zenith" })],
  ["cannot cancel", () => reports.cannotCancelMessage(3, "paid")],
  ["resent", () => reports.resendMessage({ number: 3, type: "invoice", clientName: "Zenith", totalKobo: 5000000, amountPaidKobo: 0 }, URL_)],
  ["converted", () => reports.convertedMessage({ invoiceNumber: 5, quoteNumber: 2, clientName: "Zenith", totalKobo: 5000000 })],
  ["cannot convert, already done", () => reports.cannotConvertMessage(2, "already_converted:5")],
  ["cannot convert, cancelled", () => reports.cannotConvertMessage(2, "cancelled")],
  ["cannot convert, missing", () => reports.cannotConvertMessage(2, "not_found")],
  ["reminders stopped", () => reports.remindersStoppedMessage(2, null)],
  ["reminders, none waiting", () => reports.remindersStoppedMessage(0, null)],

  ["draft summary", () => summary.draftSummary(draft, TODAY, "free")],
  ["ask for client", () => summary.askFor("client_name", {})],
  ["ask for amount", () => summary.askFor("amount", { clientName: "Zenith" })],
  ["ask for amount, no client", () => summary.askFor("amount", {})],
  ["ask for description", () => summary.askFor("description", { clientName: "Zenith" })],
  ["ask for due date", () => summary.askFor("due_date", { clientName: "Zenith" })],
  ["ask, fallback", () => summary.askFor("something_else", {})],
  // The note is part of this message now, not one of its own, so the caption
  // is what has to obey the one-emoji rule.
  ["sent, an invoice", () => summary.sentMessage(draft, { number: 7, publicToken: "abc" }, URL_, TODAY).forward],
  ["sent, a quote", () => summary.sentMessage({ ...(draft as object), type: "quote" } as never, { number: 7, publicToken: "abc" }, URL_, TODAY).forward],

  ["paid in full", () => notify.paidMessage(notice as never)],
  ["part payment", () => notify.paidMessage({ ...notice, paidKobo: 2000000, amountPaidKobo: 2000000, fullyPaid: false } as never)],

  ["settings menu", () => settings.settingsMenu({ businessName: "Ada Studio", account, pending: null })],
  ["bank change scheduled", () => settings.bankChangeScheduled({ bankName: "GTBank", accountName: "ADA", accountNumber: "0123456789" }, new Date("2026-09-22T14:20:00Z"))],
  ["account closed", () => settings.deletionStarted()],

  ["pro offer", () => billing.proOffer(3)],
  ["pro, deducting", () => billing.deductChosen()],
  ["pro pay link", () => billing.payLinkMessage("https://x.ng/p")],
  ["pro started", () => billing.proStarted()],

  ["security alert", () => alerts.alertMessage({ what: "a bank change was requested", detail: ["GTBank ••6789"], undoHint: "reply stop." } as never, "14:20 today")],
];

/** VOICE entries that take arguments, with something plausible to render. */
const VOICE_ARGS: Record<string, unknown[]> = {
  gotNameAskBank: ["Ada Studio"],
  // Two currencies in one message, which is the only VOICE entry taking two.
  whichCurrency: ["dollars", "naira"],
  askCode: ["ada@adastudio.ng"],
  notBuiltYet: ["Referrals"],
  // The question asked when a price arrives with no word for which line it
  // belongs to. Three lines sharing their first two words, because that is
  // the case its example has to survive.
  whichItem: [
    {
      type: "invoice",
      lines: [
        { description: "Sole Capsule Website UI", qty: 1, unitAmountKobo: 350_000_00 },
        { description: "Sole Capsule Website Development", qty: 1, unitAmountKobo: 750_000_00 },
        { description: "Sole Capsule SEO", qty: 1, unitAmountKobo: 150_000_00 },
      ],
    },
    400_000_00,
  ],
};

const renderVoice = (key: string, value: unknown): string =>
  typeof value === "function"
    ? (value as (...a: unknown[]) => string)(...(VOICE_ARGS[key] ?? ["x"]))
    : String(value);

test("every message the bot sends", async (t) => {
  const all: [string, string][] = [
    // Only the prose. VOICE also holds button sets, which are not messages:
    // a two-word button title cannot open with an emoji and carry bold, and
    // machine.test.ts audits them against Meta's limits instead.
    ...Object.entries(VOICE)
      .map(([k, v]) => [`VOICE.${k}`, renderVoice(k, v)] as [string, unknown])
      .filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    ...messages.map(([name, f]) => [name, f()] as [string, string]),
  ];

  /*
   * One message is exempt, deliberately.
   *
   * The code step had three emoji across the message and its two buttons —
   * two of them near-identical envelopes — which is the clutter this whole
   * rule exists to prevent, arriving through the back door. The rule counts
   * per message; a message and its buttons are what somebody actually looks
   * at, and nothing on that screen needs decorating anyway.
   *
   * Stated here rather than quietly skipped, and kept to one. A list of
   * exemptions is how a design rule stops being one.
   */
  const NO_EMOJI = new Set(["VOICE.askCode"]);

  await t.test("opens with an emoji", () => {
    for (const [name, text] of all) {
      if (NO_EMOJI.has(name)) {
        assert.doesNotMatch(text, OPENS_WITH_EMOJI, `${name} is exempt but now has one`);
        continue;
      }
      assert.match(text, OPENS_WITH_EMOJI, `${name} opens with ${JSON.stringify(text.slice(0, 40))}`);
    }
  });

  /*
   * One opener, and — where a message is genuinely a list — one marker
   * repeated.
   *
   * The rule that matters is that emoji stay meaningful, and what destroys
   * that is *variety*: five different pictures in a message and the eye has
   * nothing to catch on. A single character repeated down a list is not
   * competing for attention, it is structure, and it reads as a tick rather
   * than as decoration.
   *
   * So the check is on how many distinct emoji a message uses, not how many
   * it contains. Two is the ceiling, and the second must be uniform.
   */
  await t.test("uses one opener, plus at most one repeated marker", () => {
    for (const [name, text] of all) {
      const found = text.match(EMOJI) ?? [];
      if (found.length <= 1) continue;

      const after = new Set(found.slice(1));
      assert.equal(
        after.size,
        1,
        `${name} mixes ${after.size} different emoji after the opener: ${[...after].join(" ")}`,
      );

      const marker = [...after][0]!;
      assert.notEqual(
        marker,
        found[0],
        `${name} reuses its opener as the list marker, so the opener stops standing out`,
      );
    }
  });

  await t.test(
    "never prints an escape sequence instead of the character",
    () => {
      // A five-digit `\U0001f4b0` is Python's spelling, not TypeScript's, and
      // TypeScript quietly renders it as the text "U0001f4b0". It has reached
      // real messages twice. Nothing here may contain one.
      for (const [name, text] of all) {
        assert.doesNotMatch(text, /\\?[uU]\+?[0-9a-f]{4,8}/i, `${name} leaks an escape`);
      }
    },
  );

  await t.test("covers enough to be worth having", () => {
    // A guard against this file quietly becoming a list of three.
    assert.ok(all.length >= 60, `only ${all.length} messages checked`);
  });
});

test("a Flow's message does not repeat the links on its own screen", () => {
  /*
   * The consent message used to print both URLs in the bubble, above a button
   * that opened a screen carrying the same two documents as taps. Two copies
   * of a link is the reader deciding which one to trust, and the screen is
   * the one with the plain-words summary next to it.
   *
   * The other half of the rule matters more. There is a path with no Flow at
   * all — until the business is verified Meta will not publish one — and on
   * that path the links have to be in the message, or somebody is agreeing to
   * documents they were never shown. So this checks both directions: gone
   * from the Flow's body, still there in the words.
   */
  const consent = FLOWS.find((f) => f.key === "consent")!;

  const urls = new Set<string>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const action = n["on-click-action"] as Record<string, unknown> | undefined;
    if (action?.name === "open_url" && typeof action.url === "string") urls.add(action.url);
    Object.values(n).forEach(collect);
  };
  collect(consent.json);

  assert.ok(urls.size >= 2, `the consent screen holds ${urls.size} documents, expected both`);

  for (const url of urls) {
    assert.ok(
      !VOICE.consentFormBody.includes(url),
      `the Flow's message repeats ${url}, which is already a tap on the screen it opens`,
    );
    assert.ok(
      VOICE.confirmedAskConsent.includes(url),
      `the words fallback has no Flow to open and has lost ${url}`,
    );
  }
});
