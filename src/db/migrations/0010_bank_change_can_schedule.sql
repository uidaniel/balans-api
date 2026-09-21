-- Let a bank change actually be scheduled (F17).
--
-- `bank_accounts_one_active` allowed exactly one row per user with
-- status='active'. The bank-change flow needs two: the account money goes to
-- today, and the one that takes over in 24 hours. The two cannot both exist,
-- so every bank change by an onboarded user failed on this constraint —
-- silently, because the throw happened inside an effect and the reply was
-- never sent. The user saw their confirmation question asked again, forever.
--
-- What replaces it is weaker on purpose, because the rule we actually want
-- cannot be written as a static index: "at most one account in force" depends
-- on now(), and an index cannot. So the real invariants live where they can be
-- enforced, and this index only stops the pathological case:
--
--   one account in force    -- accountInForce() takes the newest row whose
--                              effective_at has passed. Deterministic, and
--                              true at every instant including during a
--                              scheduled change.
--   one scheduled change    -- scheduleBankChange() retires any future-dated
--                              row inside the same transaction before it
--                              inserts the new one.
--   no exact duplicates     -- this index.
--
-- Rows superseded by a change that has since taken effect stay 'active' with
-- an older effective_at until the next change tidies them. They are never
-- chosen, because the ordering picks the newest.

DROP INDEX IF EXISTS bank_accounts_one_active;

CREATE UNIQUE INDEX bank_accounts_one_per_effective_at
  ON bank_accounts (user_id, effective_at)
  WHERE status = 'active';

-- Reading "which account is in force, and is one scheduled?" happens on every
-- settings view and every payment split, and both sides of that question sort
-- on effective_at.
CREATE INDEX bank_accounts_by_effective_at
  ON bank_accounts (user_id, effective_at DESC)
  WHERE status = 'active';
