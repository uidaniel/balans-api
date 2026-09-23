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
): Promise<{ id: string; priceKobo: number }> {
  const priceKobo = defaults.plans.pro.priceKobo;

  return tx(async (c) => {
    // One open subscription at a time. Asking twice should not owe twice.
    const { rows: open } = await c.query<{ id: string; price_kobo: number }>(
      `SELECT id, price_kobo FROM subscriptions
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
      return { id: open[0].id, priceKobo: open[0].price_kobo };
    }

    const start = new Date();
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

/** Who to remind, 3 days before expiry (F18, `pro_renewal`). */
export async function renewalsDue(): Promise<
  { userId: string; waPhone: string; expiresAt: Date; priceKobo: number }[]
> {
  const { rows } = await db().query<{
    id: string;
    wa_phone: string;
    plan_expires_at: Date;
  }>(
    `SELECT u.id, u.wa_phone, u.plan_expires_at
       FROM users u
      WHERE u.plan = 'pro'
        AND u.status = 'active'
        AND u.plan_expires_at BETWEEN now() AND now() + interval '3 days'
        -- Once per period: a renewal notice every hour would be its own reason
        -- to cancel.
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.user_id = u.id
             AND m.template = 'pro_renewal'
             AND m.created_at > u.plan_expires_at - interval '4 days'
        )`,
  );

  return rows.map((r) => ({
    userId: r.id,
    waPhone: r.wa_phone,
    expiresAt: r.plan_expires_at,
    priceKobo: defaults.plans.pro.priceKobo,
  }));
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

  log.warn(
    { userId: sub.user_id, subscriptionId: sub.id, paidKobo, until: sub.period_end },
    "pro activated by payment",
  );

  return {
    userId: sub.user_id,
    subscriptionId: sub.id,
    priceKobo: sub.price_kobo,
    until: sub.period_end,
  };
}
