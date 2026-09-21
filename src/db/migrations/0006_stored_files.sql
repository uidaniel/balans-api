-- Somewhere to keep rendered PDFs.
--
-- Section 3 calls for object storage with signed URLs, and that is where this
-- goes eventually. It is Postgres today for one reason: the API already has a
-- database and does not yet have a bucket, and an invoice PDF that exists is
-- worth more than one that is waiting on an S3 account.
--
-- The `key` is deliberately the same shape a bucket would use, and every
-- caller goes through src/storage/files.ts, so moving to object storage is a
-- change to that one module. Nothing else knows where bytes live.
--
-- Size is the reason this is a temporary arrangement: an invoice PDF is around
-- 30 KB, which is nothing at a thousand invoices and a real table at a million.

CREATE TABLE stored_files (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  byte_size    INTEGER NOT NULL,
  -- What it belongs to, so a deleted user's files go with them (section 12).
  user_id      UUID REFERENCES users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT stored_files_size_matches CHECK (byte_size = length(bytes)),
  -- A PDF that large is a bug, not a document.
  CONSTRAINT stored_files_not_absurd CHECK (byte_size > 0 AND byte_size < 20 * 1024 * 1024)
);

CREATE INDEX stored_files_by_user ON stored_files (user_id);

-- The rendered document for a version (F20: every version of an edit is kept).
-- pdf_key already exists on document_versions and receipts; this is what it
-- points at.
