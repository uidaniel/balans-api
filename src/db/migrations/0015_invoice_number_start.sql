-- An invoice number the user chooses to start from.
--
-- The number is printed on the document and on the payment page, and the whole
-- message that carries an invoice is built to be forwarded to the client
-- untouched. So "INVOICE #3" told the client this was the third invoice its
-- sender had ever issued — a number that is only a count of how new you are.
--
-- Hiding it is the wrong fix: clients and accountants expect an invoice to
-- carry a number, and in some contexts it is required. The right fix is the
-- one every invoicing tool has, which is to let the number start wherever the
-- user says. Somebody moving from a paper book or another tool needs this
-- anyway, so that their numbering does not restart at 1 and collide with what
-- they have already issued.
--
-- Allocation becomes GREATEST(MAX(number) + 1, invoice_number_start), which
-- has the property that matters: raising it skips forward, and lowering it
-- does nothing. Numbers can never repeat or go backwards, whatever is set
-- here, and documents_number_per_user_type still guarantees that.

ALTER TABLE users
  ADD COLUMN invoice_number_start INTEGER NOT NULL DEFAULT 1
    -- One is the honest default: a first invoice really is the first one.
    -- The cap keeps it inside INTEGER once a few thousand have been issued on
    -- top, and no real business is numbering above it.
    CHECK (invoice_number_start >= 1 AND invoice_number_start <= 2000000000);

COMMENT ON COLUMN users.invoice_number_start IS
  'Lowest number a new document may take. Raising it skips forward; lowering it does nothing.';
