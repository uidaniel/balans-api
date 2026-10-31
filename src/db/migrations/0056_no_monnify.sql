-- Paystack is the only processor (31 October 2026).
--
-- The previous processor was retired on 3 October 2026 and the code no
-- longer knows it exists. Three things in the database still pointed at it,
-- and this settles them without removing any history:
--
--   1. Payments it opened and nobody finished. Nothing will ever confirm
--      them: the invoice page now polls only Paystack's pending payments
--      (documents/payments.ts, `pendingPaymentsFor`), and there is nobody
--      left to ask about these references. Left 'initialised' they read as
--      a payment still in flight. They are marked 'failed', which is what an
--      abandoned checkout becomes. Their `provider` value is left as it was:
--      it is a record of who took the attempt, and the admin views count
--      payments by it.
--
--   2. The column defaults. `payments.provider` and `bank_accounts.provider`
--      have defaulted to the old processor since 0001. Every insert in the
--      code names its provider, so nothing changes today; the default is
--      corrected so a row written without one is not quietly attributed to
--      a processor that no longer exists. Setting a default rewrites no rows.
--
--   3. The description on `bank_accounts.subaccount_code`, which still named
--      the old processor. Accounts added before 26 September 2026 hold that
--      processor's bank codes and subaccount codes, and keep them: a card
--      payment translates the bank by name (payments/paystack-subaccount.ts).
--
-- Nothing is dropped or renamed, and no stored value other than the stale
-- statuses in (1) changes. Safe to run more than once.

UPDATE payments
   SET status = 'failed'
 WHERE status = 'initialised'
   AND provider NOT IN ('paystack', 'offline');

ALTER TABLE payments      ALTER COLUMN provider SET DEFAULT 'paystack';
ALTER TABLE bank_accounts ALTER COLUMN provider SET DEFAULT 'paystack';

COMMENT ON COLUMN bank_accounts.subaccount_code IS
  'The previous processor''s subaccount, on accounts added before 26 September 2026. Paystack''s is paystack_subaccount_code.';
