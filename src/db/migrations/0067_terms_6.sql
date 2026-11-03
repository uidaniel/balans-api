-- Terms and privacy 6.0 (published 4 November 2026, in force 4 December 2026).
--
-- The Nigeria Data Protection Act's directive (GAID 2025, Art. 18(1)(e))
-- wants consent before personal data goes to a country the Commission has
-- not approved, and asked for on its own (Art. 27(4)), not inside "I agree to
-- the terms". Our database and servers are in Ireland and the language model
-- and email in the United States, so it is asked: at setup, and with 6.0.
ALTER TABLE users
  ADD COLUMN transfer_consent_at TIMESTAMPTZ,
  -- When the one-time notice of 6.0 went, so it goes once.
  ADD COLUMN terms_notice_at TIMESTAMPTZ;

-- And when it went by email, which is its own send.
ALTER TABLE users ADD COLUMN terms_email_at TIMESTAMPTZ;
