-- Find a payment by the processor's own reference.
--
-- Our `reference` is what we send at initialisation and what the transaction
-- webhook echoes back. But a refund, a chargeback and a settlement report all
-- arrive quoting Monnify's reference instead — they are events about the
-- transaction, not about our request — and there was no way to look one up.
--
-- It lived inside raw_verify_json, which is a record rather than an index: a
-- JSONB scan across every payment to answer "whose refund is this?".

ALTER TABLE payments ADD COLUMN provider_reference TEXT;

-- Backfilled from what was already stored, so existing rows are findable too.
UPDATE payments
   SET provider_reference = COALESCE(
         raw_verify_json ->> 'transactionReference',
         raw_verify_json ->> 'providerReference'
       )
 WHERE provider_reference IS NULL
   AND raw_verify_json IS NOT NULL;

-- Not unique: Monnify can reuse a reference across a transaction and its
-- refund, and a unique index would reject the second event rather than record
-- it. Uniqueness lives on `reference`, which is ours and which we control.
CREATE INDEX payments_by_provider_reference
  ON payments (provider_reference) WHERE provider_reference IS NOT NULL;
