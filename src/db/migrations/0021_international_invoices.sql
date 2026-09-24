-- Invoices priced abroad and paid here (International PRD section 11).
--
-- The shape of the thing, because it decides every column below. An invoice
-- for $500 is *presented* in dollars and *charged and settled* in naira: the
-- client's card is debited in naira by Paystack, their own bank converts, and
-- what arrives is naira. So the dollar figure is the price two people agreed,
-- and the naira figure is the money.
--
-- Which means the document's own arithmetic stays in kobo, exactly as it is
-- today. Totals, VAT, payment parts, what is owed, what has been paid, the
-- monthly summary, the fee engine — none of them learn about currency. The
-- foreign price rides alongside as a label, and one conversion at the moment
-- the invoice is created is the entire difference. Anything else would mean
-- auditing every money path in the product for which unit it is holding.
--
-- TWO DEPARTURES FROM SECTION 11, both to avoid storing a number twice.
--
--   `original_currency` is not added. `documents.currency` has existed since
--   0001, has always defaulted to 'NGN', and is read by nothing. It is this
--   column. Two columns naming the currency of one document is how they come
--   to disagree.
--
--   `charge_amount_kobo` is not added either, because section 11 also says
--   "total_kobo holds the naira charge for international invoices" — which is
--   true, and makes the extra column a copy of it. The naira charge is
--   `total_kobo`, as it is for every other invoice in the system.
--
-- Nothing here is reachable until the feature flag is on. Every column is
-- nullable and every default is what a naira invoice already means, so this
-- migration changes no existing row's behaviour.

/* -------------------------------------------------------------------------- */
/* The rate, and where it came from                                           */
/* -------------------------------------------------------------------------- */

-- Section 6: the rate is fetched, cached, and locked onto the invoice at
-- creation. This table is the cache and the history.
--
-- History rather than a single current value, because a rate that was used to
-- price somebody's work is evidence. When a user asks in March why their
-- January invoice converted at 1,327, the answer has to be a row, not a
-- recollection — and the nightly reconciliation needs to check a settlement
-- against the rate that was actually in force, not the one showing today.
CREATE TABLE fx_rates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'USDNGN', 'GBPNGN'. Naira per one unit of the foreign currency.
  pair       TEXT NOT NULL,
  rate       NUMERIC(18, 6) NOT NULL,
  -- Which provider said so. Recorded on the invoice too, so an invoice can
  -- always name its own source even after the provider is changed.
  source     TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The provider's whole response, for the day one of them starts lying.
  raw_json   JSONB,

  CONSTRAINT fx_rates_rate_positive CHECK (rate > 0)
);

-- The cache lookup is "the newest rate for this pair", on every draft.
CREATE INDEX fx_rates_pair_fetched ON fx_rates (pair, fetched_at DESC);

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

ALTER TABLE documents
  ADD COLUMN original_amount_minor BIGINT,
  ADD COLUMN fx_rate               NUMERIC(18, 6),
  ADD COLUMN fx_source             TEXT,
  ADD COLUMN fx_fetched_at         TIMESTAMPTZ;

COMMENT ON COLUMN documents.currency IS
  'What the invoice is priced in: NGN, USD or GBP. Section 11 calls this original_currency.';
COMMENT ON COLUMN documents.original_amount_minor IS
  'The foreign price as agreed, in cents or pence. Null on a naira invoice.';
COMMENT ON COLUMN documents.total_kobo IS
  'The naira charge. On a foreign invoice this is original_amount_minor converted at fx_rate.';

-- Only what we can actually take. A currency nobody wrote a provider for must
-- not be storable, because a row saying 'EUR' would be an invoice nothing can
-- collect and nothing can refund.
ALTER TABLE documents
  ADD CONSTRAINT documents_currency_supported
  CHECK (currency IN ('NGN', 'USD', 'GBP'));

-- Acceptance criterion 6, as a constraint rather than a hope: "the rate on the
-- invoice does not change after creation, and the invoice records its source
-- and timestamp". A foreign invoice without its rate is one nobody can explain
-- afterwards — not to the client who was charged, not to the freelancer who
-- was paid, and not to us when the two figures are questioned.
ALTER TABLE documents
  ADD CONSTRAINT documents_foreign_locks_its_rate
  CHECK (
    currency = 'NGN'
    OR (original_amount_minor IS NOT NULL AND original_amount_minor > 0
        AND fx_rate IS NOT NULL AND fx_source IS NOT NULL AND fx_fetched_at IS NOT NULL)
  );

-- And the mirror of it: a naira invoice may not carry FX fields, so the
-- presence of a rate always means the same thing.
ALTER TABLE documents
  ADD CONSTRAINT documents_naira_has_no_rate
  CHECK (
    currency <> 'NGN'
    OR (original_amount_minor IS NULL AND fx_rate IS NULL
        AND fx_source IS NULL AND fx_fetched_at IS NULL)
  );

/* -------------------------------------------------------------------------- */
/* Line items                                                                 */
/* -------------------------------------------------------------------------- */

-- The prices in kobo are what is charged; these are what was agreed.
--
-- Kept per line rather than only on the document because the invoice the
-- client reads shows the work line by line, and a client who agreed to $200
-- for the logo should see $200 for the logo. Deriving it back from the naira
-- would reintroduce the rounding that converting once was meant to avoid, and
-- would put a figure on somebody's invoice that they never quoted.
ALTER TABLE line_items
  ADD COLUMN original_unit_amount_minor BIGINT,
  ADD COLUMN original_amount_minor      BIGINT;

COMMENT ON COLUMN line_items.original_amount_minor IS
  'What this line was quoted at in the invoice currency. Null on a naira invoice.';

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

-- `provider` is already free text and already defaults to 'monnify'; foreign
-- payments write 'paystack'. Section 8 asks for the card's origin as well,
-- which is worth having for two reasons: a Nigerian card paying an
-- international invoice is still a valid payment and we must be able to see
-- that that is what happened, and chargeback risk is not evenly spread across
-- the world.
ALTER TABLE payments
  ADD COLUMN card_country          TEXT,
  ADD COLUMN is_international_card BOOLEAN;

COMMENT ON COLUMN payments.card_country IS
  'ISO country of the issuing card, when the provider reports one.';

/* -------------------------------------------------------------------------- */
/* Bank accounts                                                              */
/* -------------------------------------------------------------------------- */

-- A user has one bank account and may now have two subaccounts against it:
-- the Monnify one that every naira invoice splits through, and a Paystack one
-- created the first time they invoice abroad. `subaccount_code` from 0001 is
-- Monnify's; this is the other.
--
-- Separate columns rather than a provider row each, because they are two
-- references to the same bank account and the account is the thing the user
-- changed, verified and owns. Splitting them into rows would mean a bank
-- change had to remember to move both.
ALTER TABLE bank_accounts
  ADD COLUMN paystack_subaccount_code   TEXT,
  ADD COLUMN paystack_subaccount_status TEXT;

COMMENT ON COLUMN bank_accounts.subaccount_code IS
  'Monnify''s subaccount for this bank account. Paystack''s is a separate column.';
