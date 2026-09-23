-- A private link to somebody's own numbers.
--
-- The summary page shows one freelancer everything they have ever invoiced:
-- what they have been paid, what is outstanding, and which clients are sitting
-- on money. That is the most sensitive page this product has, and it opens
-- inside WhatsApp's web view where there is nobody to log in as.
--
-- So the link is the credential, and it is made to expire. 32 hex characters
-- is 128 bits from a CSPRNG, which is not enumerable; the expiry is what
-- covers the rest of the threat model, which is not an attacker at all but a
-- forwarded chat. Somebody shows a friend their invoice thread, and a link
-- that lives for ever is a permanent window into their earnings.
--
-- Reissued every time they ask, so the freshest link always works and the
-- older ones die on their own.
ALTER TABLE users ADD COLUMN summary_token            TEXT;
ALTER TABLE users ADD COLUMN summary_token_expires_at TIMESTAMPTZ;

-- Unique so a lookup by token can never return two people, which is the one
-- failure this page must not have.
CREATE UNIQUE INDEX users_summary_token ON users (summary_token);
