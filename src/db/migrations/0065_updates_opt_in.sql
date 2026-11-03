-- Asking before sending updates (3 November 2026). The privacy notice says
-- anything promotional goes only to people who asked, and Meta wants opt-in
-- before a marketing template. So an announcement goes only to somebody who
-- said yes: the box at setup, the one-time question after an invoice, or
-- START UPDATES. STOP UPDATES (updates_off_at, 0061) still wins.
ALTER TABLE users
  ADD COLUMN updates_opt_in_at TIMESTAMPTZ,
  -- When the one-time question went, so it is never asked twice.
  ADD COLUMN updates_asked_at TIMESTAMPTZ;
