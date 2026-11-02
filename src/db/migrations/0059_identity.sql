-- Who is behind an account that takes card payments from abroad
-- (20 October 2026; shipped 2 November 2026 as 0059). See src/identity/verify.ts.
--
-- A card from abroad can be reversed months after it settled. If the account
-- that took it has gone, Paystack recovers it from Balans. So before an
-- account can send a card invoice abroad, its person is checked against
-- their NIN with a selfie, and their payout account is tied to them: by
-- name, or for a business account, by the CAC register naming them.
--
-- `identity_status`:
--   none      not started
--   person    NIN and selfie passed; the payout account is not tied yet
--             (a business account waiting for its RC or BN number)
--   verified  person and account both check out
--   review    something did not match and a person is looking at it
--
-- The NIN is kept encrypted like an account number, with its last four for
-- showing. The selfie is never stored. `identity_checks` is the record of
-- every check made, without images, for a dispute or the police.
ALTER TABLE users
  ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'none'
    CHECK (identity_status IN ('none', 'person', 'verified', 'review')),
  ADD COLUMN identity_verified_at TIMESTAMPTZ,
  ADD COLUMN legal_name TEXT,
  ADD COLUMN nin_encrypted BYTEA,
  ADD COLUMN nin_last4 TEXT,
  ADD COLUMN business_reg_number TEXT,
  ADD COLUMN identity_token TEXT,
  ADD COLUMN identity_token_expires_at TIMESTAMPTZ,
  -- The invoice that sent them to verify, brought back as a draft with its
  -- buttons the moment they pass. Cleared when used; ignored after a day.
  ADD COLUMN identity_pending_doc JSONB,
  ADD COLUMN identity_pending_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_identity_token ON users (identity_token) WHERE identity_token IS NOT NULL;

CREATE TABLE identity_checks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('liveness', 'nin_selfie', 'name_match', 'cac')),
  outcome    TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'error')),
  reason     TEXT,
  detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX identity_checks_by_user ON identity_checks (user_id, created_at DESC);

-- Only the API reads these, as the owner.
REVOKE ALL ON identity_checks FROM PUBLIC;
