-- Paying by the sender's own details, instead of a Balans link.
--
-- A client abroad may pay by PayPal, Wise or a bank transfer the sender
-- arranges themselves, and a Balans card link is then the wrong thing to put
-- in front of them. So a user keeps their own payment details, says whether
-- invoices abroad go out with those or with a link, and can choose per
-- invoice. An invoice that goes out with them carries a copy, so changing the
-- details later never rewrites one already sent.
--
-- Balans cannot see these payments. The user marks them paid, as with a naira
-- bank transfer.

ALTER TYPE delivery_type ADD VALUE IF NOT EXISTS 'own_details';

ALTER TABLE users
  ADD COLUMN payment_details TEXT CHECK (char_length(payment_details) <= 600),
  -- What an invoice abroad goes out with when nobody said: 'link' or 'own'.
  ADD COLUMN abroad_pay_by TEXT NOT NULL DEFAULT 'link' CHECK (abroad_pay_by IN ('link', 'own'));

ALTER TABLE documents
  -- Chosen for this document; null means the sender's default.
  ADD COLUMN pay_by TEXT CHECK (pay_by IN ('link', 'own')),
  -- The details as they were when the document was sent.
  ADD COLUMN payment_details TEXT;
