-- A signature for the "Authorised signature" line on invoices and quotes.
--
-- Until now every layout drew that line with nothing above it: a space for a
-- pen on a document nobody prints. A signature is drawn or typed on a page
-- opened from the chat ("signature"), and only a document whose sender has
-- one carries the line at all.
--
-- `signature_url` is a storage key, the same shape as `logo_url`. The token
-- is the page's only credential, and like the summary link it expires after
-- a day: a forwarded chat should not be a way to sign somebody's invoices.

ALTER TABLE users ADD COLUMN signature_url             TEXT;
ALTER TABLE users ADD COLUMN signature_token           TEXT;
ALTER TABLE users ADD COLUMN signature_token_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_signature_token ON users (signature_token);
