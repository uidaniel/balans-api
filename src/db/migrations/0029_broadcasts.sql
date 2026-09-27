-- Broadcasts: one message to many people, queued by the admin, sent by the API.
--
-- The database is the queue. The admin writes a broadcast and its recipients;
-- the API's broadcast loop picks up anything queued within seconds and works
-- through it, recording what happened to each person. So the admin needs no
-- key to the API and the API needs no endpoint for the admin — the two already
-- share this database and nothing else.
--
-- A test is a broadcast with one recipient, so the test goes through exactly
-- the path the real send will, which is the only way a test proves anything.

CREATE TABLE broadcasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign      TEXT NOT NULL,                       -- e.g. 'launch_live'
  kind          TEXT NOT NULL CHECK (kind IN ('test', 'live')),
  channels      TEXT[] NOT NULL DEFAULT ARRAY['whatsapp', 'email'],
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sending', 'done', 'failed', 'cancelled')),
  created_by    TEXT,                                -- the staff email that pressed the button
  note          TEXT,                                -- why it failed, if it did
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX broadcasts_by_status ON broadcasts (status, created_at);

CREATE TABLE broadcast_recipients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id   UUID NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  phone          TEXT,                               -- +234..., or null for email only
  email          TEXT,
  wa_status      TEXT NOT NULL DEFAULT 'pending'
                 CHECK (wa_status IN ('pending', 'sent', 'failed', 'skipped')),
  wa_via         TEXT,                               -- 'template', or 'preview' for a test before approval
  wa_error       TEXT,
  email_status   TEXT NOT NULL DEFAULT 'pending'
                 CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_error    TEXT,
  sent_at        TIMESTAMPTZ
);

-- One row per number per broadcast: pressing Send twice, or a waitlist with a
-- duplicate, cannot message somebody twice from the same broadcast.
CREATE UNIQUE INDEX broadcast_recipients_one_phone
  ON broadcast_recipients (broadcast_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX broadcast_recipients_pending
  ON broadcast_recipients (broadcast_id) WHERE wa_status = 'pending' OR email_status = 'pending';

-- Closed to the public roles from the start. See 0026 for why this matters.
ALTER TABLE broadcasts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON broadcasts, broadcast_recipients FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON broadcasts, broadcast_recipients FROM authenticated;
  END IF;
END
$$;
