-- Close what the public anon key could read and write.
--
-- Supabase grants `anon` and `authenticated` full rights — read AND write —
-- on every table in `public` by default, and exposes `public` over its REST
-- API. The anon key is not a secret: it ships in browser bundles by design.
-- What makes that safe is row level security — a table with RLS on and no
-- policy returns nothing to those roles and accepts nothing from them. Most
-- tables here had it turned on. These did not. Found on 27 September 2026 by
-- sweeping the catalog for every table and view `anon` could select from:
--
--   stored_files        Every invoice PDF, receipt and card: readable,
--                       overwritable and deletable.
--   fx_rates            Writable. The product prices a foreign invoice from
--                       the newest rate for a pair, so anybody could have set
--                       what a dollar invoice charges in naira.
--   verification_codes  HMAC'd with a server key, so none could be forged,
--                       but they could be read and deleted.
--   monthly_summaries   Every user's monthly figures.
--   schema_migrations   Deleting a row makes the next boot re-run it.
--   admin_metrics       Views run as their owner and skip RLS, so these
--   admin_documents     returned every invoice's reference, business, client
--                       and amounts.
--
-- Nothing legitimate touches any of these with the anon key. The API and the
-- migration runner connect as the tables' owner, which RLS does not apply to,
-- and the admin reads the views with the service key, which bypasses it.

ALTER TABLE stored_files       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates           ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations  ENABLE ROW LEVEL SECURITY;

-- A view that checks the caller's rights rather than its owner's, so RLS on
-- the tables underneath applies to whoever is asking.
ALTER VIEW admin_metrics   SET (security_invoker = true);
ALTER VIEW admin_documents SET (security_invoker = true);

-- And no grant to begin with. Either of these alone would do; both, because
-- the next view somebody adds may forget one of them. Guarded, because a
-- plain Postgres (tests, a laptop) has no Supabase roles to revoke from.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_metrics, admin_documents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_metrics, admin_documents FROM authenticated;
  END IF;
END
$$;
