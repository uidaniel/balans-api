-- Subscription revenue that was paid by link but never recorded.
--
-- Until 29 September 2026, a Pro month paid through the Paystack link was
-- switched on without a `fee_ledger` row, so the admin's "What Balans earns"
-- said ₦0 while MRR counted the customer. billing/subscription.ts now writes
-- the row; this adds the ones already missed, dated when they were paid.
--
-- Only link-paid months (deductions always wrote theirs), only ones that
-- collected money, and only where that user has no subscription row at all
-- yet, so running it against a database that already has them adds nothing.

INSERT INTO fee_ledger (user_id, payment_id, type, amount_kobo, created_at)
SELECT s.user_id, NULL, 'subscription', s.amount_collected_kobo, COALESCE(s.paid_at, s.period_start)
  FROM subscriptions s
 WHERE s.collection_method = 'link'
   AND s.amount_collected_kobo > 0
   AND NOT EXISTS (
     SELECT 1 FROM fee_ledger f WHERE f.user_id = s.user_id AND f.type = 'subscription'
   );
