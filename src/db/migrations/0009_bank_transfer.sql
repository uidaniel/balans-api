-- Paying by transfer on our own page, instead of Monnify's hosted checkout.
--
-- Monnify hands back a one-time account per transaction, valid for about 40
-- minutes. It is kept here for two reasons: so a client who refreshes, or who
-- comes back from their banking app, sees the same account rather than a new
-- one while a transfer is already in flight; and so a payment that arrives
-- late can still be tied to the account it was sent to.
--
-- Nothing here decides whether a payment happened. That is still the webhook
-- plus a verified status check, and these columns are never read to that end.

ALTER TABLE payments
  ADD COLUMN transfer_bank_name      TEXT,
  ADD COLUMN transfer_bank_code      TEXT,
  ADD COLUMN transfer_account_number TEXT,
  ADD COLUMN transfer_account_name   TEXT,
  ADD COLUMN transfer_ussd           TEXT,
  ADD COLUMN transfer_expires_at     TIMESTAMPTZ;

-- Finding the live account for a document is on the path of every page view,
-- so it gets its own index rather than a scan of the document's history.
CREATE INDEX payments_live_transfer
  ON payments (document_id, transfer_expires_at DESC)
  WHERE status = 'initialised' AND transfer_account_number IS NOT NULL;
