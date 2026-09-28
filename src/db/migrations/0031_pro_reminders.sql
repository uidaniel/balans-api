-- Which Pro reminders have gone, so each goes exactly once.
--
-- The renewal notice used to find out whether it had been sent by looking for
-- a message recorded with template 'pro_renewal'. A message sent inside the
-- 24-hour window is free text and is recorded with no template, so for
-- anybody who had used the chat that day the check found nothing and the
-- hourly job sent it again, every hour, for three days.
--
-- A row here is written before the message goes (and removed if it fails), so
-- the job asks this table and nothing else. One row per person, per Pro
-- period (its end date), per stage.

CREATE TABLE pro_reminders (
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_end  TIMESTAMPTZ NOT NULL,
  stage       TEXT NOT NULL
              CHECK (stage IN ('ending_soon', 'ended', 'grace_ending', 'lapsed', 'win_back')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_end, stage)
);

ALTER TABLE pro_reminders ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON pro_reminders FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON pro_reminders FROM authenticated;
  END IF;
END
$$;
