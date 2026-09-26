-- Pro is paid by transfer to an account Paystack opens for that one payment.
--
-- The account is kept on the subscription so that opening the payment page
-- again shows the same one. Without it, a phone that reloads the page on the
-- way back from a bank app would be handed a fresh account under a fresh
-- reference, and the transfer already made to the first would arrive with a
-- reference no subscription holds any more: paid, and never switched on.
--
-- Reused until it expires. After that Paystack returns anything sent to it,
-- so a new account under a new reference is safe.

ALTER TABLE subscriptions
  ADD COLUMN transfer_bank_name      TEXT,
  ADD COLUMN transfer_account_number TEXT,
  ADD COLUMN transfer_account_name   TEXT,
  ADD COLUMN transfer_expires_at     TIMESTAMPTZ;
