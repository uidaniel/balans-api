-- Seven more currencies to invoice in: euros, Canadian and Australian
-- dollars, cedis, Kenyan shillings, rand and dirhams.
--
-- Each is priced exactly as dollars and pounds are: a label on the invoice,
-- converted to naira at a rate fetched, recorded and locked when it is sent,
-- or paid straight to the sender's own details. Nothing new collects them.

ALTER TABLE documents DROP CONSTRAINT documents_currency_supported;
ALTER TABLE documents
  ADD CONSTRAINT documents_currency_supported
  CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR', 'CAD', 'AUD', 'GHS', 'KES', 'ZAR', 'AED'));

COMMENT ON COLUMN documents.currency IS
  'What the invoice is priced in: NGN or one of the foreign currencies in core/currency.ts.';
COMMENT ON COLUMN documents.original_amount_minor IS
  'The foreign price as agreed, in its minor units (cents, pence, pesewas…). Null on a naira invoice.';
