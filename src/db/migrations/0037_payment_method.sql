-- How somebody outside Nigeria is paid: the method they chose at setup
-- (PayPal, Wise, a bank transfer…), beside the details they typed.
--
-- Balans cannot check an account outside Nigeria, so nothing is verified:
-- the method and the details are printed on their invoices as they gave
-- them (see migration 0034 for `payment_details`).

ALTER TABLE users
  ADD COLUMN payment_method TEXT CHECK (char_length(payment_method) <= 40);
