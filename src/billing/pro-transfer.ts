/**
 * The account somebody pays into for a month of Pro.
 *
 * Pro is paid by bank transfer through Paystack, since 26 September 2026: a
 * Paystack account is opened for the one payment, and the `charge.success`
 * webhook under the `sub_` reference chosen here turns it into a month of Pro,
 * a WhatsApp receipt and an emailed one. Nothing here marks anything paid.
 *
 * Asked for from the chat ("Pay Now"), which puts the account in the reply,
 * and from /pro/start, which is where the offer's button pointed before that
 * and which old offers in people's chats still point at.
 */

import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../db/pool.ts";
import { chargeByTransfer } from "../payments/paystack.ts";
import { attachPaymentReference, openSubscription } from "./subscription.ts";

/** How long an account stays open. Long enough to find a bank app and log in. */
export const ACCOUNT_MINUTES = 60;

export type ProAccount = {
  bankName: string;
  accountNumber: string;
  accountName: string;
  expiresAt: Date;
};

export type ProTransfer =
  | { kind: "account"; account: ProAccount; amountKobo: number }
  | { kind: "already_pro" }
  | { kind: "failed"; message: string };

export async function openProTransfer(userId: string, log: FastifyBaseLogger): Promise<ProTransfer> {
  const { rows } = await db().query<{
    email: string | null;
    business_name: string | null;
    plan: "free" | "pro";
  }>(`SELECT email, business_name, plan FROM users WHERE id = $1 AND status = 'active'`, [userId]);

  const user = rows[0];
  if (!user) return { kind: "failed", message: "no such user" };
  // Already paid. Showing an account would take the money twice.
  if (user.plan === "pro") return { kind: "already_pro" };

  const opened = await openSubscription(userId, "link", log);

  /*
   * The account already open for this subscription, if it has not expired,
   * so tapping "Pay Now" twice shows the same number rather than a second one.
   *
   * A minute's margin, so nobody is shown an account that closes while they
   * are typing the number in.
   */
  const { rows: held } = await db().query<{
    transfer_bank_name: string | null;
    transfer_account_number: string | null;
    transfer_account_name: string | null;
    transfer_expires_at: Date | null;
  }>(
    `SELECT transfer_bank_name, transfer_account_number, transfer_account_name, transfer_expires_at
       FROM subscriptions
      WHERE id = $1 AND transfer_expires_at > now() + interval '1 minute'`,
    [opened.id],
  );
  const h = held[0];
  if (h?.transfer_account_number && h.transfer_expires_at) {
    return {
      kind: "account",
      amountKobo: opened.priceKobo,
      account: {
        bankName: h.transfer_bank_name ?? "Paystack",
        accountNumber: h.transfer_account_number,
        accountName: h.transfer_account_name ?? "Balans",
        expiresAt: h.transfer_expires_at,
      },
    };
  }

  const reference = `sub_${opened.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;
  const charged = await chargeByTransfer({
    email: user.email ?? `${userId}@users.balans.ng`,
    amountKobo: opened.priceKobo,
    reference,
    expiresAt: new Date(Date.now() + ACCOUNT_MINUTES * 60_000),
    metadata: { purpose: "balans_pro", user_id: userId, business: user.business_name ?? "" },
  });

  if (!charged.ok) {
    log.error({ userId, message: charged.message }, "could not open a Pro transfer account");
    return { kind: "failed", message: charged.message };
  }

  const a = charged.account;
  // Without the reference the webhook has nothing to match the payment to,
  // and a paid subscription stays pending for ever.
  await attachPaymentReference(opened.id, a.reference);
  await db().query(
    `UPDATE subscriptions
        SET status = 'pending',
            transfer_bank_name = $2, transfer_account_number = $3,
            transfer_account_name = $4, transfer_expires_at = $5
      WHERE id = $1`,
    [opened.id, a.bankName, a.accountNumber, a.accountName, a.expiresAt],
  );

  log.info({ userId, reference: a.reference }, "Pro transfer account opened");
  return {
    kind: "account",
    amountKobo: opened.priceKobo,
    account: { bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName, expiresAt: a.expiresAt },
  };
}
