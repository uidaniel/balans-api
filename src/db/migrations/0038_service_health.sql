-- How each thing Balans depends on is doing, for the admin's Health page.
--
-- The API checks every one every two minutes (src/jobs/health.ts) and keeps
-- the latest answer here, one row per check. The admin only reads it, so it
-- needs no way to call the API — and a page whose rows have all stopped
-- updating is itself the sign that the API is down.

CREATE TABLE service_health (
  name        TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'down')),
  latency_ms  INTEGER,
  detail      TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last time it was fine, so "down for 20 minutes" can be said.
  last_ok_at  TIMESTAMPTZ
);

ALTER TABLE service_health ENABLE ROW LEVEL SECURITY;
