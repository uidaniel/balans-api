-- When the team was last emailed about a check being down (ops/alerts.ts),
-- so a check that stays down is said again every few hours, not every two
-- minutes.

ALTER TABLE service_health ADD COLUMN alerted_at TIMESTAMPTZ;
