-- What a payment settles against the invoice, as opposed to what was charged.
--
-- These are the same number until fees are passed to the client. When they
-- are, the client is charged the invoice amount grossed up by the processor's
-- cut — the whole point being that the freelancer still receives the full
-- amount — and the difference is a surcharge for moving money, not part of
-- what was billed.
--
-- The confirmation path had only `client_total_kobo` to work from, so it
-- credited the invoice with the surcharge too. A ₦215,000 invoice with a 25%
-- deposit of ₦53,750 was charged at ₦54,670.06, and the page then read:
--
--     Paid        −₦54,670.06
--     Still owed   ₦160,329.94        (should be ₦161,250)
--     Balance      ₦161,250           (the plan, which was right)
--
-- Two different figures for the same debt on one page, and the smaller one
-- was in the biggest type. Nobody lost money — the balance charged is still
-- computed from the plan — but an invoice that cannot agree with itself about
-- what is owed is not one anybody should send to a client.
--
-- Backfilled with client_total_kobo: for every payment that did not pass fees
-- on, that is exactly the right answer, and for the handful that did it is
-- what already happened. History is not rewritten here; the documents whose
-- totals are wrong are corrected deliberately, or left, and either way this
-- column is what every payment from now on is credited by.

ALTER TABLE payments ADD COLUMN invoice_amount_kobo BIGINT;

UPDATE payments SET invoice_amount_kobo = client_total_kobo
 WHERE invoice_amount_kobo IS NULL;

COMMENT ON COLUMN payments.invoice_amount_kobo IS
  'What this payment settles against the invoice. Differs from client_total_kobo only when fees are passed to the client, by the amount of the surcharge.';
