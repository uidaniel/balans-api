-- Somebody moved to Pro from the admin hears about it, as a paying customer
-- does. The admin app only writes to the database, so the API watches
-- `audit_log` for promotions and marks each one when its message has gone.
--
-- Every promotion before this migration is marked already: they happened
-- days ago, and a welcome now would be news to nobody.

ALTER TABLE audit_log ADD COLUMN notified_at TIMESTAMPTZ;

UPDATE audit_log SET notified_at = now() WHERE action = 'plan.promote';

CREATE INDEX audit_log_unnotified_promotions ON audit_log (created_at)
  WHERE action = 'plan.promote' AND notified_at IS NULL;
