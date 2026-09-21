-- Which invoice design a user has chosen.
--
-- Eight layouts exist (two Free, six Pro). The choice belongs to the user
-- rather than the document: somebody who picks Ledger wants every invoice in
-- Ledger, not to choose again each time.
--
-- Null means the default, so no backfill is needed and a template that is
-- later withdrawn degrades to the default rather than failing to render.

ALTER TABLE users ADD COLUMN template_id TEXT;

-- The picker is a web page, and the link to it goes out over WhatsApp.
--
-- It cannot be keyed on a document's public token: the client has that link
-- too, and a client must never be able to restyle the invoices of the business
-- billing them. This is the user's own secret, from a CSPRNG, and it is theirs
-- alone.
ALTER TABLE users ADD COLUMN picker_token TEXT UNIQUE;

CREATE INDEX users_by_picker_token ON users (picker_token) WHERE picker_token IS NOT NULL;
