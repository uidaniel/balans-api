-- How long each step takes on live (3 November 2026): see src/lib/timing.ts.
-- Only the step and its milliseconds; nothing about the person. Kept 30 days
-- by the daily cleanup.
CREATE TABLE step_timings (
  id   BIGSERIAL PRIMARY KEY,
  step TEXT NOT NULL CHECK (char_length(step) <= 40),
  ms   INTEGER NOT NULL CHECK (ms >= 0),
  at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX step_timings_by_step ON step_timings (step, at DESC);
CREATE INDEX step_timings_by_at ON step_timings (at);

ALTER TABLE step_timings ENABLE ROW LEVEL SECURITY;

-- Each step over the last 7 days: how many, the middle, the slow tenth, the worst.
CREATE VIEW admin_timings WITH (security_invoker = true) AS
SELECT
  step,
  count(*)::int AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::int AS p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::int AS p90_ms,
  max(ms)::int AS max_ms
FROM step_timings
WHERE at > now() - interval '7 days'
GROUP BY step;

COMMENT ON VIEW admin_timings IS 'Each step''s duration over 7 days: count, median, slowest tenth, worst.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON step_timings, admin_timings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON step_timings, admin_timings FROM authenticated;
  END IF;
END
$$;
