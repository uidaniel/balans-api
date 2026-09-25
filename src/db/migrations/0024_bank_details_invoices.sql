-- Naira invoices carry the sender's own bank details, not a payment link.
--
-- From the Bank Details Invoices addendum (24 Sep 2026), as decided: an
-- invoice priced in naira is paid by transfer straight to the freelancer's
-- verified account, and an invoice priced abroad keeps its card link, since a
-- client abroad cannot send naira to a Nigerian account.
--
-- `delivery_type` records which a document went out as. Existing rows were
-- all sent with links and stay that way; nothing sent is ever reinterpreted.
--
-- The account is copied onto the document when it is sent, not referenced:
-- a later bank change (F17) must never alter an invoice a client already has.
-- The number is encrypted as it is in `bank_accounts`, and the last four are
-- kept beside it for anything that only needs to say which account.

CREATE TYPE delivery_type AS ENUM ('payment_link', 'bank_details');

ALTER TABLE documents
  ADD COLUMN delivery_type                        delivery_type NOT NULL DEFAULT 'payment_link',
  ADD COLUMN bank_details_bank_name               TEXT,
  ADD COLUMN bank_details_account_name            TEXT,
  ADD COLUMN bank_details_account_last4           TEXT,
  ADD COLUMN bank_details_account_number_encrypted BYTEA;

-- A bank-details document without the account on it would tell a client to
-- pay and not say where.
ALTER TABLE documents
  ADD CONSTRAINT documents_bank_details_complete
  CHECK (
    delivery_type = 'payment_link'
    OR (bank_details_bank_name IS NOT NULL AND bank_details_account_name IS NOT NULL
        AND bank_details_account_last4 IS NOT NULL
        AND bank_details_account_number_encrypted IS NOT NULL)
  );
