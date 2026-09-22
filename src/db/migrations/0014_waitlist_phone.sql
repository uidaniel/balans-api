-- Waitlist becomes phone-first (F24, F25).
--
-- Balans is a WhatsApp product. The beta invite arrives as a WhatsApp message
-- and the open announcement will too, so the number is the field we cannot do
-- without and the address is the one we can. That inverts what 0002 assumed:
-- email was NOT NULL and was the unique key.
--
-- The form is now three steps in one place. Step one takes the number alone
-- and commits the row, so somebody who abandons step two is still a lead. Step
-- two adds email, trade and billing cadence and is what picks the beta.

ALTER TABLE waitlist ALTER COLUMN email DROP NOT NULL;

ALTER TABLE waitlist
  -- Stored normalised as +234XXXXXXXXXX. One shape in the column means the
  -- launch broadcast can read it straight out without parsing eleven variants
  -- of the same number.
  ADD COLUMN phone        TEXT,
  -- How often they bill. With `work`, this is what picks the twenty beta users.
  ADD COLUMN cadence      TEXT CHECK (cadence IN ('weekly', 'monthly', 'sometimes')),
  -- Public referral tag. Goes in the share link this person sends on, so a
  -- signup that arrives through them lands with `via` set to this.
  ADD COLUMN code         TEXT,
  -- Private. The only thing it authorises is filling in step two of this row,
  -- and it is never put in a shareable link. `code` is public and must not be
  -- reused for this: a referral link would otherwise hand the recipient the
  -- ability to rewrite the sender's entry.
  ADD COLUMN token        TEXT,
  -- `code` of whoever shared the link this signup came through.
  ADD COLUMN via          TEXT,
  ADD COLUMN details_at   TIMESTAMPTZ,
  ADD COLUMN confirmed_at TIMESTAMPTZ;

-- One row per number, same contract the address had: signing up twice is a
-- no-op the form can answer without a second round trip.
CREATE UNIQUE INDEX waitlist_phone_unique ON waitlist (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX waitlist_code_unique ON waitlist (code) WHERE code IS NOT NULL;
CREATE INDEX waitlist_by_via ON waitlist (via) WHERE via IS NOT NULL;

-- The step-two lookup. Partial, because most rows have no token to match and
-- an index over those is dead weight.
CREATE INDEX waitlist_by_token ON waitlist (token) WHERE token IS NOT NULL;

-- 0002's unique index was over lower(email) with email NOT NULL. Nullable now,
-- and Postgres treats NULLs in a unique index as distinct, so many rows
-- without an address coexist while two rows with the same one still cannot.
