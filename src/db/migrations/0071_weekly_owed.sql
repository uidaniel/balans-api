-- The Monday "who owes you" (5 November 2026, jobs/weekly-owed.ts).
--
-- When each person last had one, so it goes once a week however often the
-- job runs, and when they asked for it to stop.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weekly_owed_at timestamptz,
  ADD COLUMN IF NOT EXISTS weekly_owed_off_at timestamptz;
