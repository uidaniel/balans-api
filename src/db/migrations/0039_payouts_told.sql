-- Telling a user when Paystack has paid their card money out to their bank.
--
-- Paystack sends no webhook for a settlement, so the API asks its
-- Settlements API every hour (payments/payouts.ts). A settlement is one
-- payout to one subaccount; once its owner has been told, it is kept here
-- and never told again.

CREATE TABLE payouts_told (
  settlement_id TEXT PRIMARY KEY,
  user_id       UUID REFERENCES users (id) ON DELETE CASCADE,
  amount_kobo   BIGINT NOT NULL,
  settled_on    DATE,
  told_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payouts_told ENABLE ROW LEVEL SECURITY;

ALTER TABLE payments ADD COLUMN settled_at TIMESTAMPTZ;
