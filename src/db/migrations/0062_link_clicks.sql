-- Taps on our tagged links (3 November 2026), for the admin panel.
--
-- balans.ng/start?ref=ig (the Instagram bio), ?ref=status, ?ref=groups and
-- the rest open the chat with "Hi Balans (ref: ig)" typed. The website writes
-- one row per tap here; the bot records who actually sent it (0060). Taps
-- against sign-ups is how many people looked and left.
--
-- Nothing about the person: no address, no number, no cookie. Link previews
-- (WhatsApp and Instagram fetch a link when it is posted) are not counted.
CREATE TABLE link_clicks (
  id          BIGSERIAL PRIMARY KEY,
  ref         TEXT NOT NULL CHECK (char_length(ref) <= 32),
  clicked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX link_clicks_by_ref ON link_clicks (ref, clicked_at DESC);

ALTER TABLE link_clicks ENABLE ROW LEVEL SECURITY;

-- Taps per tag, so the admin reads a handful of rows, not every tap.
CREATE VIEW admin_link_clicks WITH (security_invoker = true) AS
SELECT ref, count(*)::int AS clicks, max(clicked_at) AS last_at
  FROM link_clicks
 GROUP BY ref;

COMMENT ON VIEW admin_link_clicks IS 'Taps on each tagged balans.ng/start link.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON link_clicks, admin_link_clicks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON link_clicks, admin_link_clicks FROM authenticated;
  END IF;
END
$$;
