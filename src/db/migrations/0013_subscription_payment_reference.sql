-- Let a paid Pro link actually switch somebody to Pro.
--
-- The pay-link branch minted a reference like `sub_<id>_<random>`, sent the
-- payer to Monnify, and kept no record of it. When the webhook arrived,
-- confirmPayment looked the reference up in `payments` — where subscription
-- payments are not written, because a payment there belongs to a document and
-- this one belongs to nobody's invoice — found nothing, and returned
-- `unknown_reference`. The money arrived and the subscription stayed pending.
--
-- The reference lives here now, so the webhook has something to match on.
--
-- Unique, because it is an idempotency key: Monnify redelivers on any doubt,
-- and two activations for one payment would hand out two months.

ALTER TABLE subscriptions
  ADD COLUMN payment_reference TEXT,
  -- Monnify's own reference, for reconciliation against their settlement
  -- report. Ours identifies the subscription; theirs identifies the money.
  ADD COLUMN provider_reference TEXT,
  ADD COLUMN paid_at TIMESTAMPTZ;

CREATE UNIQUE INDEX subscriptions_payment_reference
  ON subscriptions (payment_reference)
  WHERE payment_reference IS NOT NULL;
