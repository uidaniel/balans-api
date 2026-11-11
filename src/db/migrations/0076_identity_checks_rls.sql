-- identity_checks closed to the public key (11 November 2026).
--
-- 0059 made the table with `REVOKE ALL ... FROM PUBLIC`, which does not touch
-- the grants Supabase gives `anon` and `authenticated` by name, and without row
-- level security, which is what actually shuts them out (see 0026). So the
-- results of identity checks were open to anybody holding the project URL and
-- the anon key, which is not a secret. Supabase's advisor flagged it on
-- 8 November ("rls_disabled_in_public").
--
-- The API and the migrations connect as the tables' owner and the admin with
-- the service key; RLS applies to neither, so nothing legitimate changes.
ALTER TABLE identity_checks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON identity_checks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON identity_checks FROM authenticated;
  END IF;
END
$$;

-- And every other table here that still has RLS off, whatever made it: one
-- missed line in a migration must not be a way in again. A table with RLS on
-- and no policy gives the public roles nothing; the ones meant to take public
-- writes (the waitlist) already have RLS and their policies, and are skipped.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;
