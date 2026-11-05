-- The sender is warned before their client is reminded (5 November 2026).
--
-- A reminder to a client who has already paid, because the sender forgot to
-- mark it, makes the client angry and the blame lands on Balans. So on a bank
-- transfer invoice the sender hears first ("I'll remind them at 2pm unless
-- you tell me they've paid"), the row becomes 'warned', and the client is
-- reminded three hours on unless it was marked paid in between.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS warned_at timestamptz;
CREATE INDEX IF NOT EXISTS reminders_warned ON reminders (warned_at) WHERE status = 'warned';
