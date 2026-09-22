/**
 * What settings says (PRD F17).
 *
 * The menu is the one screen in the product that has to show state rather than
 * ask a question, so it leads with what is true now: the business name on the
 * invoices, and the account the money goes to. Somebody opening settings is
 * usually checking one of those two things, not changing anything.
 */

import { b, i, lines, para } from "../whatsapp/format.ts";
import { CHANGE_DELAY_HOURS, type ActiveAccount } from "./bank-change.ts";

export function settingsMenu(x: {
  businessName: string | null | undefined;
  account: ActiveAccount | null;
  pending: { bankName: string; last4: string; accountName: string; effectiveAt: Date } | null;
}): string {
  /*
   * The name, then the bank and the last four.
   *
   * The number itself is encrypted at rest and only its last four digits are
   * kept in the clear (section 11), so there is nothing here to show even if
   * it were wise to — and it is not: this screen gets screenshotted and
   * forwarded like any other.
   *
   * The name is what answers the question somebody opens this to ask. "Is
   * that my account?" is settled instantly by "ADA OKON" and barely at all by
   * four digits, and it is already loaded.
   */
  const now = x.account
    ? lines(
        `Paid into ${b(x.account.accountName)}`,
        `${x.account.bankName} ••${x.account.last4}`,
      )
    : b("No payout account yet");

  const scheduled = x.pending
    ? i(
        `A change to ${x.pending.bankName} ••${x.pending.last4} takes effect ${whenWords(x.pending.effectiveAt)}.`,
      )
    : "";

  return para(
    `⚙️ ${b(x.businessName ?? "Your account")}`,
    lines(now, scheduled),
    lines(
      "1  Change your business name",
      "2  Change your payout bank",
      "3  Change your default due days",
      "4  Change your invoice design",
      "5  Change your invoice number",
      "6  Close your account",
    ),
    `Reply with a number, or ${b("cancel")}.`,
  );
}

/**
 * F17 step 4, said plainly.
 *
 * The delay is the protection, so it is stated as a fact rather than buried:
 * a user who did not expect it should be able to act on that sentence.
 */
export function bankChangeScheduled(
  change: { bankName: string; accountName: string; accountNumber: string },
  effectiveAt: Date,
): string {
  return para(
    `✅ Your payouts will move to ${b(`${change.bankName} ••${change.accountNumber.slice(-4)}`)}.`,
    lines(
      `In ${b(`${CHANGE_DELAY_HOURS} hours`)} — ${whenWords(effectiveAt)}.`,
      "Until then, money still goes to your current account.",
      "That delay is deliberate: it gives you time to stop it if this was not you.",
    ),
    `We have emailed you about it. Reply ${b("stop")} to cancel the change.`,
  );
}

export function deletionStarted(): string {
  return para(
    `👋 ${b("Your account is closed.")}`,
    lines(
      "Unpaid invoices are cancelled and your payout account is disconnected.",
      "Records of money that already moved are kept, as the law requires.",
    ),
    "If this was a mistake, email hello@balans.ng within 30 days.",
  );
}

/** "tomorrow at 14:20", in Lagos, because that is where the person is. */
function whenWords(at: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(at);
}

/* -------------------------------------------------------------------------- */

/**
 * The same menu, as something to tap (F17).
 *
 * The row ids are phrases the parser already understands, so a tap arrives as
 * an ordinary message and travels the same path as somebody typing it. Nothing
 * downstream has to know the difference between a tap and a sentence.
 */
export function settingsList(x: {
  businessName: string | null | undefined;
  account: ActiveAccount | null;
  pending: { bankName: string; last4: string; accountName: string; effectiveAt: Date } | null;
  /** How long clients get to pay, in days. */
  dueDays: number;
  /** The chosen invoice design, by name. Null while it is still the default. */
  designName: string | null;
  /** The number the next invoice will take, when it is not simply the next one. */
  invoiceStart: number;
}): {
  body: string;
  button: string;
  sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
  header?: string;
  footer?: string;
} {
  const now = x.account
    ? `Paid into ${x.account.accountName}
${x.account.bankName} ••${x.account.last4}`
    : "No payout account yet";

  const scheduled = x.pending
    ? `\nA change to ${x.pending.bankName} ••${x.pending.last4} takes effect ${whenWords(x.pending.effectiveAt)}.`
    : "";

  /*
   * The body is what somebody sees before tapping anything, so it carries the
   * whole picture rather than only the bank.
   *
   * The rows repeat these values, and that is fine — the rows are behind a
   * tap and are where you go to change one. This is the glance.
   */
  const design = x.designName ?? "Classic";
  const numbering = x.invoiceStart > 1 ? ` · next #${x.invoiceStart}` : "";
  const rest = `${design} design · ${x.dueDays} ${x.dueDays === 1 ? "day" : "days"} to pay${numbering}`;

  return {
    header: x.businessName ?? "Your account",
    body: `${now}${scheduled}

${rest}`,
    button: "Change something",
    footer: "Nothing changes until you confirm it",
    /*
     * Each row says what that setting is *now*.
     *
     * It used to describe what the setting was for — "the name your clients
     * see on every invoice" — which the title already says in two words. So
     * the screen could tell you everything you were able to change and
     * nothing about what any of it was set to, which is the question somebody
     * opens settings to answer.
     *
     * Closing the account keeps its warning. That one is not a value.
     */
    sections: [
      {
        rows: [
          {
            id: "change business name",
            title: "Business name",
            description: x.businessName ?? "Not set yet",
          },
          {
            id: "change bank",
            title: "Payout bank",
            description: x.account
              ? `${x.account.bankName} ••${x.account.last4} — ${x.account.accountName}`
              : "Not set up yet",
          },
          {
            id: "due days",
            title: "Default due days",
            description: `${x.dueDays} ${x.dueDays === 1 ? "day" : "days"} to pay`,
          },
          {
            // Reads as a command, like every other row, so tapping it goes
            // through the same path as typing it.
            id: "invoice design",
            title: "Invoice design",
            description: x.designName ?? "Classic, the default",
          },
          {
            id: "invoice number",
            title: "Invoice number",
            description:
              x.invoiceStart > 1 ? `Starting at ${x.invoiceStart}` : "Counting from 1",
          },
          {
            id: "delete my account",
            title: "Close my account",
            description: "Cancels unpaid invoices and disconnects payouts",
          },
        ],
      },
    ],
  };
}
