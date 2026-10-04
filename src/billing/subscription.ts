/**
 * Pro (PRD F18).
 *
 * Two ways to pay, because the freelancers this is for do not all have a card
 * and almost all of them have an invoice coming:
 *
 *   - A payment link, for the first month.
 *   - "Take it from my next paid invoice", which is the one that actually
 *     fits: it costs nothing until somebody pays them.
 *
 * The deduction has a cap, and the cap is the interesting part. F18: "The
 * total Balans charge on any single payment may not exceed 20% of that
 * payment; any remainder carries to the following payment." Without it, a
 * ₦5,000 invoice would arrive with ₦4,000 of subscription taken out of it, and
 * the user would quite reasonably never trust us again.
 */

import { ensureSubaccountEarly } from "../payments/subaccount-verification.ts";
import type { FastifyBaseLogger } from "fastify";
import { db, tx } from "../db/pool.ts";
import { defaults } from "../config.ts";

/** F18: the total Balans charge on any one payment. */
export const MAX_CHARGE_SHARE_BPS = 2_000; // 20%

/** F18: one month from activation, then 7 days of grace. */
export const GRACE_DAYS = 7;

export type Plan = "free" | "pro";
/** Matches the `collection_method` enum exactly; Postgres rejects anything else. */
export type CollectionMethod = "link" | "deduct_from_invoice";

/* -------------------------------------------------------------------------- */
/* How much of this payment can we take                                       */
/* -------------------------------------------------------------------------- */

export type Deduction = {
  /** What to add to our charge on this payment. */
  takeKobo: number;
  /** What could not be taken and waits for the next one. */
  carryKobo: number;
};

/**
 * Works out how much subscription to take from one payment.
 *
 * `balansFeeKobo` is already committed — it is our transaction fee and it is
 * not negotiable — so the cap applies to the two together and the
 * subscription gets whatever room is left. On a small payment that is nothing,
 * and nothing is the right answer: the debt carries.
 *
 * Pure, so every awkward case below is a test rather than a hope.
 */
export function deductionFor(
  paymentKobo: number,
  balansFeeKobo: number,
  owedKobo: number,
): Deduction {
  if (owedKobo <= 0 || paymentKobo <= 0) return { takeKobo: 0, carryKobo: Math.max(0, owedKobo) };

  const ceiling = Math.floor((paymentKobo * MAX_CHARGE_SHARE_BPS) / 10_000);
  // Our transaction fee comes first. If it alone is already at the cap, the
  // subscription waits.
  const room = Math.max(0, ceiling - balansFeeKobo);
  const takeKobo = Math.min(owedKobo, room);

  return { takeKobo, carryKobo: owedKobo - takeKobo };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type SubscriptionState = {
  plan: Plan;
  /** Null on Free. */
  periodEnd: Date | null;
  /** True while inside the grace period after expiry (F18). */
  inGrace: boolean;
  collectionMethod: CollectionMethod | null;
  /** Subscription money still to collect, in kobo. */
  owedKobo: number;
};

export async function stateOf(userId: string): Promise<SubscriptionState> {
  const { rows } = await db().query<{
    plan: Plan;
    plan_expires_at: Date | null;
    plan_collection_method: CollectionMethod | null;
    owed: string;
  }>(
    `SELECT u.plan, u.plan_expires_at, u.plan_collection_method,
            COALESCE((
              SELECT SUM(s.price_kobo - s.amount_collected_kobo)
                FROM subscriptions s
               WHERE s.user_id = u.id AND s.status IN ('pending', 'collecting')
            ), 0) AS owed
       FROM users u WHERE u.id = $1`,
    [userId],
  );

  const r = rows[0];
  if (!r) return { plan: "free", periodEnd: null, inGrace: false, collectionMethod: null, owedKobo: 0 };

  const now = Date.now();
  const end = r.plan_expires_at?.getTime() ?? 0;
  const graceEnds = end + GRACE_DAYS * 86_400_000;

  // Expired but inside the grace period is still Pro (F18). Past it is Free,
  // whatever the column says, so nothing has to remember to write it back.
  const expired = r.plan === "pro" && end > 0 && now > end;
  const inGrace = expired && now <= graceEnds;
  const plan: Plan = r.plan === "pro" && (!expired || inGrace) ? "pro" : "free";

  return {
    plan,
    periodEnd: r.plan_expires_at,
    inGrace,
    collectionMethod: r.plan_collection_method,
    owedKobo: Number(r.owed),
  };
}

/**
 * Whether somebody on Pro may pay for the next month now: in its last three
 * days, or in the grace week after it. Earlier than that a second payment
 * would only be a mistake, so "upgrade" says they are on Pro and the checkout
 * refuses it.
 */
export function renewalOpen(state: SubscriptionState, now = new Date()): boolean {
  if (state.plan !== "pro" || !state.periodEnd) return false;
  return state.inGrace || state.periodEnd.getTime() - now.getTime() <= 3 * 86_400_000;
}

/* -------------------------------------------------------------------------- */
/* Starting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Opens a subscription that has not been paid for yet.
 *
 * Deliberately not activating anything. Pro begins when money arrives — the
 * first deduction succeeds, or the link is paid — and until then this is a
 * debt with a plan attached.
 */
export async function openSubscription(
  userId: string,
  method: CollectionMethod,
  log: FastifyBaseLogger,
  /** Outside Nigeria, their local price in naira at today's rate (billing/price.ts). */
  priceKobo: number = defaults.plans.pro.priceKobo,
): Promise<{ id: string; priceKobo: number }> {

  return tx(async (c) => {
    // One open subscription at a time. Asking twice should not owe twice.
    const { rows: open } = await c.query<{ id: string; price_kobo: number; status: string }>(
      `SELECT id, price_kobo, status FROM subscriptions
        WHERE user_id = $1 AND status IN ('pending', 'collecting')
        ORDER BY period_start DESC LIMIT 1`,
      [userId],
    );

    if (open[0]) {
      await c.query(`UPDATE subscriptions SET collection_method = $2 WHERE id = $1`, [
        open[0].id,
        method,
      ]);
      await c.query(`UPDATE users SET plan_collection_method = $2 WHERE id = $1`, [userId, method]);
      /*
       * Opened at an old price and nothing paid yet: take today's. The price
       * went from ₦4,000 to ₦3,000 on 26 September 2026, and an offer that
       * says ₦3,000 must not open an account asking for ₦4,000. The transfer
       * account goes with it, because Paystack matches a transfer by amount.
       * A subscription already collecting from invoices keeps its figure.
       */
      if (open[0].status === "pending" && open[0].price_kobo !== priceKobo) {
        await c.query(
          `UPDATE subscriptions
              SET price_kobo = $2, transfer_bank_name = NULL, transfer_account_number = NULL,
                  transfer_account_name = NULL, transfer_expires_at = NULL
            WHERE id = $1`,
          [open[0].id, priceKobo],
        );
        return { id: open[0].id, priceKobo };
      }
      return { id: open[0].id, priceKobo: open[0].price_kobo };
    }

    /*
     * The new month starts when the current one ends, not today.
     *
     * Renewing three days early used to start the month on the day of
     * payment, and activation takes the later of the two end dates, so the
     * three days already paid for were simply lost. Somebody who renews early
     * because we reminded them should not be charged for it.
     */
    const { rows: current } = await c.query<{ plan_expires_at: Date | null }>(
      `SELECT plan_expires_at FROM users WHERE id = $1 AND plan = 'pro'`,
      [userId],
    );
    const now = new Date();
    const paidUntil = current[0]?.plan_expires_at ?? null;
    const start = paidUntil && paidUntil > now ? new Date(paidUntil.getTime()) : now;
    const end = new Date(start.getTime());
    end.setMonth(end.getMonth() + 1);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO subscriptions
         (user_id, plan, period_start, period_end, price_kobo, collection_method, status)
       VALUES ($1, 'pro', $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [userId, start, end, priceKobo, method],
    );

    await c.query(`UPDATE users SET plan_collection_method = $2 WHERE id = $1`, [userId, method]);
    log.info({ userId, method, priceKobo }, "subscription opened");
    return { id: rows[0]!.id, priceKobo };
  });
}

/* -------------------------------------------------------------------------- */
/* Collecting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records subscription money collected from a payment, and activates Pro on
 * the first kobo that arrives.
 *
 * Called from the payment confirmation, inside the same flow that credits the
 * user — so the deduction and the money it came out of are recorded together
 * or not at all.
 */
export async function collect(
  userId: string,
  paymentId: string,
  amountKobo: number,
  log: FastifyBaseLogger,
): Promise<{ activated: boolean; stillOwedKobo: number }> {
  if (amountKobo <= 0) return { activated: false, stillOwedKobo: 0 };

  return tx(async (c) => {
    const { rows } = await c.query<{
      id: string;
      price_kobo: number;
      amount_collected_kobo: number;
      period_end: Date;
    }>(
      `SELECT id, price_kobo, amount_collected_kobo, period_end
         FROM subscriptions
        WHERE user_id = $1 AND status IN ('pending', 'collecting')
        ORDER BY period_start DESC LIMIT 1
        FOR UPDATE`,
      [userId],
    );

    const sub = rows[0];
    if (!sub) return { activated: false, stillOwedKobo: 0 };

    const collected = sub.amount_collected_kobo + amountKobo;
    const settled = collected >= sub.price_kobo;

    await c.query(
      `UPDATE subscriptions
          SET amount_collected_kobo = $2, status = $3
        WHERE id = $1`,
      [sub.id, collected, settled ? "active" : "collecting"],
    );

    // F18: "Pro activates when the first deduction succeeds or the link is
    // paid." The first kobo, not the last — somebody paying by instalment
    // should not wait for the final one.
    const { rows: userRows } = await c.query<{ plan: Plan }>(
      `UPDATE users
          SET plan = 'pro',
              plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), $2)
        WHERE id = $1
        RETURNING plan`,
      [userId, sub.period_end],
    );

    // F18: subscription revenue is recorded separately from transaction fees.
    await c.query(
      `INSERT INTO fee_ledger (user_id, payment_id, type, amount_kobo)
       VALUES ($1, $2, 'subscription', $3)`,
      [userId, paymentId, amountKobo],
    );

    log.info(
      { userId, amountKobo, collected, priceKobo: sub.price_kobo, settled },
      "subscription collected",
    );

    return {
      activated: userRows.length > 0,
      stillOwedKobo: Math.max(0, sub.price_kobo - collected),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Expiry                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Returns accounts to Free once the grace period is over (F18).
 *
 * "Pro-only settings (logo, reminders) are kept but inactive." Nothing is
 * deleted here for exactly that reason: the plan column changes and everything
 * else waits for them to come back.
 */
export async function expireLapsedSubscriptions(log: FastifyBaseLogger): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE users
        SET plan = 'free'
      WHERE plan = 'pro'
        AND plan_expires_at IS NOT NULL
        AND plan_expires_at < now() - ($1 || ' days')::interval`,
    [String(GRACE_DAYS)],
  );

  if (rowCount) log.info({ count: rowCount }, "subscriptions lapsed to free");
  return rowCount ?? 0;
}

/**
 * The reminders around the end of a Pro month, in order.
 *
 * Pro does not renew by itself: somebody pays again or it ends. So there is
 * one notice before, and then a few after, because the one before is easy to
 * miss and losing Pro without a word is how people find out from a client.
 *
 *   ending_soon    3 days before it ends
 *   ended          the day it ends: the grace week has started
 *   grace_ending   the last day of the grace week
 *   lapsed         the day they move to Free
 *   win_back       a week after that, and then nothing more
 *
 * Each window is a day wide or more, so an hour the job missed does not lose
 * a stage, and each closes before the next opens, so a job that was down for
 * a week sends the one that is due now rather than every one it missed.
 *
 * Only an end date says a month ran out. Somebody an admin moved to Free has
 * none (see the admin's plan control), so they are never told their Pro
 * "ended"; neither is anybody who was never on Pro.
 */
export type ProStage = "ending_soon" | "ended" | "grace_ending" | "lapsed" | "win_back";

const STAGE_WHERE: Record<ProStage, string> = {
  ending_soon: `u.plan = 'pro' AND u.plan_expires_at > now() AND u.plan_expires_at <= now() + interval '3 days'`,
  ended: `u.plan = 'pro' AND u.plan_expires_at <= now() AND u.plan_expires_at > now() - interval '6 days'`,
  grace_ending: `u.plan = 'pro' AND u.plan_expires_at <= now() - interval '6 days'
                 AND u.plan_expires_at > now() - (${GRACE_DAYS} || ' days')::interval`,
  lapsed: `u.plan = 'free' AND u.plan_expires_at <= now() - (${GRACE_DAYS} || ' days')::interval
           AND u.plan_expires_at > now() - interval '12 days'`,
  win_back: `u.plan = 'free' AND u.plan_expires_at <= now() - interval '14 days'
             AND u.plan_expires_at > now() - interval '21 days'`,
};

export async function proRemindersDue(
  stage: ProStage,
): Promise<{ userId: string; waPhone: string; expiresAt: Date; priceKobo: number }[]> {
  const { rows } = await db().query<{ id: string; wa_phone: string; plan_expires_at: Date }>(
    `SELECT u.id, u.wa_phone, u.plan_expires_at
       FROM users u
      WHERE u.status = 'active'
        AND u.plan_expires_at IS NOT NULL
        AND ${STAGE_WHERE[stage]}
        AND NOT EXISTS (
          SELECT 1 FROM pro_reminders r
           WHERE r.user_id = u.id AND r.period_end = u.plan_expires_at AND r.stage = $1
        )`,
    [stage],
  );
  return rows.map((r) => ({
    userId: r.id,
    waPhone: r.wa_phone,
    expiresAt: r.plan_expires_at,
    priceKobo: defaults.plans.pro.priceKobo,
  }));
}

/**
 * Takes the right to send one reminder. False if it was already taken, by
 * this run or another: the row is the lock, so two workers cannot both send.
 */
export async function claimProReminder(userId: string, periodEnd: Date, stage: ProStage): Promise<boolean> {
  const { rowCount } = await db().query(
    `INSERT INTO pro_reminders (user_id, period_end, stage) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, periodEnd, stage],
  );
  return (rowCount ?? 0) > 0;
}

/** Gives the claim back when the message did not go, so the next run tries again. */
export async function releaseProReminder(userId: string, periodEnd: Date, stage: ProStage): Promise<void> {
  await db().query(`DELETE FROM pro_reminders WHERE user_id = $1 AND period_end = $2 AND stage = $3`, [
    userId,
    periodEnd,
    stage,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Paying for Pro directly (F18)                                              */
/* -------------------------------------------------------------------------- */

/** Remembers the reference a pay-link was opened under, so a webhook can find it. */
export async function attachPaymentReference(
  subscriptionId: string,
  reference: string,
): Promise<void> {
  await db().query(
    `UPDATE subscriptions SET payment_reference = $2 WHERE id = $1`,
    [subscriptionId, reference],
  );
}

export type SubscriptionPayment = {
  userId: string;
  subscriptionId: string;
  priceKobo: number;
  until: Date;
};

/**
 * Turns a paid reference into an active month.
 *
 * Called only from the verified confirmation path, so by the time it runs
 * Monnify has already been asked whether this reference was really paid.
 *
 * Idempotent by the same rule as everything else that moves money: the update
 * only matches a subscription that is not already active, so a redelivered
 * webhook finds nothing to do and returns null rather than granting a second
 * month.
 */
export async function activateByReference(
  reference: string,
  paidKobo: number,
  providerReference: string,
  log: FastifyBaseLogger,
): Promise<SubscriptionPayment | null> {
  const { rows } = await db().query<{
    id: string;
    user_id: string;
    price_kobo: number;
    period_end: Date;
  }>(
    `UPDATE subscriptions
        SET status = 'active',
            amount_collected_kobo = $2,
            provider_reference = $3,
            paid_at = now()
      WHERE payment_reference = $1
        AND status IN ('pending', 'collecting')
      RETURNING id, user_id, price_kobo, period_end`,
    [reference, paidKobo, providerReference],
  );

  const sub = rows[0];
  if (!sub) return null;

  /*
   * The same two columns the deduction path writes, and for the same reason.
   *
   * This one set `plan` alone. A subscription paid by link therefore left
   * `plan_expires_at` null, and null is not a date in the past: `planOf` and
   * `stateOf` both read it as "no expiry", `expireLapsedSubscriptions` skips
   * it on `IS NOT NULL`, and `renewalsDue` skips it on the BETWEEN. So
   * somebody who paid for one month by card had Pro permanently, was never
   * asked to renew, and was never billed again — and nothing anywhere said
   * so, because every one of those four places was behaving as written.
   *
   * GREATEST, so paying early extends the period rather than truncating it.
   */
  await db().query(
    `UPDATE users
        SET plan = 'pro',
            plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), $2)
      WHERE id = $1`,
    [sub.user_id, sub.period_end],
  );

  /*
   * F18: subscription revenue is recorded separately from transaction fees,
   * as the deduction path does. This path did not, so a Pro month paid by
   * card or transfer switched Pro on and showed in MRR but never reached
   * "What Balans earns" — ₦0 beside a paying customer, found on 29 September
   * 2026. Once per payment: a redelivered webhook stops at the update above.
   */
  await db().query(
    `INSERT INTO fee_ledger (user_id, payment_id, type, amount_kobo) VALUES ($1, NULL, 'subscription', $2)`,
    [sub.user_id, paidKobo],
  );

  log.warn(
    { userId: sub.user_id, subscriptionId: sub.id, paidKobo, until: sub.period_end },
    "pro activated by payment",
  );
  // Cards are Pro: make their Paystack subaccount now, so it can be verified
  // before a client pays (Paystack holds payouts to unverified ones).
  ensureSubaccountEarly(sub.user_id, log);

  return {
    userId: sub.user_id,
    subscriptionId: sub.id,
    priceKobo: sub.price_kobo,
    until: sub.period_end,
  };
}
