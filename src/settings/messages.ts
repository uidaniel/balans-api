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
  const now = x.account
    ? `Paid into ${b(`${x.account.bankName} ••${x.account.last4}`)}`
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
      "4  Close your account",
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
