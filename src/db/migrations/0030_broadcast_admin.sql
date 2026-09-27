-- What the admin's Broadcast page reads, and the one way it starts a real send.
--
-- The page shows each broadcast with how far it has got. Counting recipients
-- in the admin would mean pulling every row of a thousand-person send over
-- the wire to add them up, so the database does the adding.

CREATE VIEW admin_broadcasts WITH (security_invoker = true) AS
SELECT
  b.id,
  b.campaign,
  b.kind,
  b.channels,
  b.status,
  b.created_by,
  b.note,
  b.created_at,
  b.started_at,
  b.finished_at,
  count(r.id)                                               AS recipients,
  count(*) FILTER (WHERE r.wa_status = 'sent')              AS wa_sent,
  count(*) FILTER (WHERE r.wa_status = 'failed')            AS wa_failed,
  count(*) FILTER (WHERE r.wa_status = 'pending')           AS wa_pending,
  count(*) FILTER (WHERE r.email_status = 'sent')           AS email_sent,
  count(*) FILTER (WHERE r.email_status = 'failed')         AS email_failed,
  count(*) FILTER (WHERE r.email_status = 'pending')        AS email_pending,
  -- For a test, who it went to and what came back; for a live send, the
  -- first error of each kind, which is usually the only one that matters.
  (array_agg(r.phone ORDER BY r.id))[1]                     AS first_phone,
  (array_agg(r.email ORDER BY r.id))[1]                     AS first_email,
  (array_agg(r.wa_via) FILTER (WHERE r.wa_via IS NOT NULL))[1]       AS wa_via,
  (array_agg(r.wa_error) FILTER (WHERE r.wa_error IS NOT NULL))[1]   AS wa_error,
  (array_agg(r.email_error) FILTER (WHERE r.email_error IS NOT NULL))[1] AS email_error
FROM broadcasts b
LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id
GROUP BY b.id;

-- The real send, as one statement the admin calls.
--
-- In here rather than in the admin because the check and the insert have to
-- be one transaction: two people pressing "Send to everyone" at once, or one
-- person pressing it twice, must produce one broadcast, not two. The lock
-- makes the second caller wait for the first and then find it.
--
-- A live send that failed outright (the template was not approved yet) does
-- not count, so it can be tried again once it is.
CREATE FUNCTION queue_waitlist_broadcast(p_campaign TEXT, p_by TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  made UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('broadcast:' || p_campaign));

  IF EXISTS (
    SELECT 1 FROM broadcasts
     WHERE campaign = p_campaign AND kind = 'live' AND status IN ('queued', 'sending', 'done')
  ) THEN
    RAISE EXCEPTION 'this campaign has already been sent to the waitlist' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO broadcasts (campaign, kind, created_by)
  VALUES (p_campaign, 'live', p_by)
  RETURNING id INTO made;

  INSERT INTO broadcast_recipients (broadcast_id, phone, email, wa_status, email_status)
  SELECT made,
         w.phone,
         w.email,
         CASE WHEN w.phone IS NULL THEN 'skipped' ELSE 'pending' END,
         CASE WHEN w.email IS NULL THEN 'skipped' ELSE 'pending' END
    FROM waitlist w
   WHERE w.unsubscribed_at IS NULL
     AND (w.phone IS NOT NULL OR w.email IS NOT NULL)
  ON CONFLICT DO NOTHING;

  RETURN made;
END
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION queue_waitlist_broadcast(TEXT, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_broadcasts FROM anon;
    REVOKE ALL ON FUNCTION queue_waitlist_broadcast(TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_broadcasts FROM authenticated;
    REVOKE ALL ON FUNCTION queue_waitlist_broadcast(TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON admin_broadcasts TO service_role;
    GRANT EXECUTE ON FUNCTION queue_waitlist_broadcast(TEXT, TEXT) TO service_role;
  END IF;
END
$$;
