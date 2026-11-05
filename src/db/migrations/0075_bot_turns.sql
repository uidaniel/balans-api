-- The daily review of the bot's answers (5 November 2026, src/review).
--
-- Each message somebody sends and what the bot said back, with phone
-- numbers, emails, account numbers and links masked before they are written,
-- and deleted after 30 days with the rest of the message text. Once a day the
-- turns that look like a wrong answer are read by a model, and what it finds
-- is kept here and emailed to the team, so each day's misses become fixes.
CREATE TABLE IF NOT EXISTS bot_turns (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  inbound text,
  quoted boolean NOT NULL DEFAULT false,
  reply text
);
CREATE INDEX IF NOT EXISTS bot_turns_at ON bot_turns (at);
CREATE INDEX IF NOT EXISTS bot_turns_user_at ON bot_turns (user_id, at);
ALTER TABLE bot_turns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bot_reviews (
  day date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  turns int NOT NULL DEFAULT 0,
  flagged int NOT NULL DEFAULT 0,
  summary text,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE bot_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON bot_turns, bot_reviews FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON bot_turns, bot_reviews FROM authenticated;
  END IF;
END
$$;
