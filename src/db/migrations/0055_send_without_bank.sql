-- The bank account step can be skipped (31 October 2026).
--
-- Setup finishes without one, and the first invoice sent without one asks
-- first: add it, or send without it. This is when they chose to send without
-- it, so the question is asked once and the reminder after it comes every
-- third invoice rather than on every one (conversation/handle.ts).
ALTER TABLE users ADD COLUMN sent_without_bank_at TIMESTAMPTZ;
