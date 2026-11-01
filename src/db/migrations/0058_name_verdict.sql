-- The name check asks only about names that look wrong (1 November 2026):
-- a sentence, a greeting, a message to us. The rules in jobs/name-check.ts
-- decide the obvious ones and the model the rest, once per name: this is the
-- name it last judged and what it said, so a rename is judged again.
ALTER TABLE users
  ADD COLUMN name_judged TEXT,
  ADD COLUMN name_looks_wrong BOOLEAN;
