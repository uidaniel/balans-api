-- A document paid to the sender's own details can be saved (4 November 2026).
--
-- 0034 added 'own_details' to delivery_type but left 0024's check alone,
-- which allows only a payment link or a complete bank stamp. So every
-- invoice sent with "My own details" was refused at "Send it" ("violates
-- check constraint documents_bank_details_complete"). The check now allows
-- the third kind too, as long as it carries the details it was sent with.
ALTER TABLE documents DROP CONSTRAINT documents_bank_details_complete;

ALTER TABLE documents
  ADD CONSTRAINT documents_bank_details_complete
  CHECK (
    delivery_type = 'payment_link'
    OR (delivery_type = 'own_details' AND payment_details IS NOT NULL AND payment_details <> '')
    OR (delivery_type = 'bank_details'
        AND bank_details_bank_name IS NOT NULL AND bank_details_account_name IS NOT NULL
        AND bank_details_account_last4 IS NOT NULL
        AND bank_details_account_number_encrypted IS NOT NULL)
  );
