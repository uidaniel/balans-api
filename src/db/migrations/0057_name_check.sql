-- "Is this your business name?" (1 November 2026).
--
-- Setup took whatever was typed into a box labelled "Business", and some
-- finished accounts carry a greeting, a sentence or a person's name where the
-- business should be. A weekly question in the chat asks them to confirm it
-- or change it (jobs/name-check.ts). Confirmed is the answer "yes", or a
-- rename from settings, either of which settles it for good.
ALTER TABLE users
  ADD COLUMN business_name_confirmed_at TIMESTAMPTZ,
  ADD COLUMN name_check_at TIMESTAMPTZ,
  ADD COLUMN name_checks INTEGER NOT NULL DEFAULT 0;
