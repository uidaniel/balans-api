-- 5 November 2026.
--
-- The win-back: once per person, ever (jobs/win-back.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS win_back_at timestamptz;

-- How far each person got through setup, step by step, so the admin can see
-- where the ones who never finish stop (conversation/setup-steps.ts). One
-- row per person per step, the first time they reach it.
CREATE TABLE IF NOT EXISTS setup_steps (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, step)
);
ALTER TABLE setup_steps ENABLE ROW LEVEL SECURITY;

-- Of everybody who started in the last 30 days, how many reached each step.
CREATE OR REPLACE VIEW admin_setup_steps WITH (security_invoker = true) AS
  WITH started AS (
    SELECT id FROM users
     WHERE deleted_at IS NULL AND created_at > now() - interval '30 days'
  )
  SELECT s.step, count(*)::int AS people, min(s.at) AS first_at, max(s.at) AS last_at
    FROM setup_steps s JOIN started u ON u.id = s.user_id
   GROUP BY s.step
  UNION ALL
  SELECT 'started', count(*)::int, NULL, NULL FROM started
  UNION ALL
  SELECT 'finished', count(*)::int, NULL, NULL
    FROM users u JOIN started s ON s.id = u.id
   WHERE u.consented_at IS NOT NULL;
COMMENT ON VIEW admin_setup_steps IS 'How many of the last 30 days of sign-ups reached each setup step.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON setup_steps, admin_setup_steps FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON setup_steps, admin_setup_steps FROM authenticated;
  END IF;
END
$$;
