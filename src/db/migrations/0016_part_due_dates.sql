-- A date for each payment part.
--
-- A "50% deposit" invoice told the client ₦25,000 was due now and ₦25,000 was
-- the "Balance", and nothing anywhere said when the balance was due. The
-- document's due date was the only date on the whole invoice and it was not
-- attached to the part it described — so a client with a deposit invoice had
-- no answer to the one question a payment plan raises.
--
-- Nullable on purpose. Every row written before this has no answer, and a
-- migration inventing one would be guessing at terms two other people agreed
-- between themselves.

ALTER TABLE payment_parts ADD COLUMN due_date DATE;
