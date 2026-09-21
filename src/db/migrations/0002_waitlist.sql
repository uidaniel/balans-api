-- Waitlist (pre-launch).
--
-- Lives in the platform database rather than a third-party form, because these
-- addresses become the first users: at launch the admin mails this table, and
-- `converted_user_id` is how we learn which of them actually arrived.
--
-- Row level security is enabled with NO policies. That is deliberate. Supabase
-- exposes every table over PostgREST using the anon key, and this table holds
-- email addresses. With RLS on and no policy, anon and authenticated both see
-- nothing; only the service role, which bypasses RLS and never leaves the
-- server, can read or write it.

CREATE TABLE waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  -- Free text: what the person bills for. Optional.
  work         TEXT,
  -- Which surface the form was on, so we can see what converts.
  source       TEXT,
  -- Attribution from the ?ref= parameter (F24, F25).
  ref          TEXT,
  -- Coarse signals, kept for abuse review only.
  ip_hash      TEXT,
  user_agent   TEXT,
  -- Set when we tell them we have opened.
  invited_at   TIMESTAMPTZ,
  -- Set when this address finishes onboarding, closing the loop on the funnel.
  converted_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  unsubscribed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per address. Signing up twice is not an error, it is a no-op, so the
-- form can answer "you are already on the list" without a second round trip.
CREATE UNIQUE INDEX waitlist_email_unique ON waitlist (lower(email));
CREATE INDEX waitlist_by_created ON waitlist (created_at DESC);
CREATE INDEX waitlist_pending_invite ON waitlist (created_at) WHERE invited_at IS NULL;

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Staff who may open the admin. Separate from `admin_users`, which is the
-- back office's own record: this one maps a Supabase Auth identity to a role,
-- so the session cookie alone is never enough to get in.
CREATE TABLE admin_allowlist (
  -- auth.users.id from Supabase Auth. Not a foreign key: the auth schema lives
  -- outside this migration's reach, and a dangling row is harmless here.
  auth_user_id UUID PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('admin', 'support')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admin_allowlist ENABLE ROW LEVEL SECURITY;
