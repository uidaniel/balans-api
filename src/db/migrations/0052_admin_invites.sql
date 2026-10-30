-- Staff invited by email, before they have signed in (30 October 2026).
--
-- `admin_allowlist` is keyed on the Supabase Auth id, which only exists once
-- somebody has signed in, so adding a person used to take two goes: they
-- sign in and are refused, then somebody with database access copies their
-- id across. An invite is the address and the role, written in advance. The
-- first time that address signs in with a magic link — which proves they own
-- it — the admin turns the invite into their allowlist row and marks it
-- claimed (balans-admin, src/lib/supabase-server.ts).
CREATE TABLE admin_invites (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  role       TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('admin', 'support')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  claimed_by UUID
);

ALTER TABLE admin_invites ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_invites FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_invites FROM authenticated;
  END IF;
END
$$;

-- No addresses here: who is staff is data, not code, and does not belong in
-- the repository's history. Invite with
--   INSERT INTO admin_invites (email, role) VALUES ('them@example.com', 'admin');
