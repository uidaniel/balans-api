-- Verification codes (PRD F17, and the email step of onboarding).
--
-- The code itself is never stored. Only an HMAC of it, so a database dump does
-- not hand over the ability to complete someone's email verification or to
-- redirect their settlement account — which is what the bank-change flow uses
-- this same table for.

CREATE TABLE verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- What the code authorises. A code for one purpose must never work for
  -- another: an email-verification code should not be able to move a bank
  -- account.
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify', 'bank_change', 'recover_number')),
  -- Where it was sent. Kept so a code cannot be replayed against a different
  -- address than the one that received it.
  destination TEXT NOT NULL,
  code_hash   BYTEA NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Finding the live code for a purpose is the hot path.
CREATE INDEX verification_codes_live
  ON verification_codes (user_id, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- For the daily purge of expired rows.
CREATE INDEX verification_codes_expired ON verification_codes (expires_at);
