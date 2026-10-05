-- Sending the launch message to the waitlist in batches, oldest first.
--
-- 0030 sent to the whole waitlist at once, and only once. The first twenty
-- are to be invited as testers before everybody else (5 October 2026), so a
-- send can now take "the next N": the earliest sign-ups this campaign has not
-- already gone to, matched by number or address, so nobody gets it twice
-- however many batches it is sent in.

CREATE FUNCTION waitlist_unsent(p_campaign TEXT)
RETURNS TABLE (id UUID, phone TEXT, email TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE
AS $$
  SELECT w.id, w.phone, w.email, w.created_at
    FROM waitlist w
   WHERE w.unsubscribed_at IS NULL
     AND (w.phone IS NOT NULL OR w.email IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM broadcast_recipients r
         JOIN broadcasts b ON b.id = r.broadcast_id
        WHERE b.campaign = p_campaign AND b.kind = 'live' AND b.status IN ('queued', 'sending', 'done')
          AND ((w.phone IS NOT NULL AND r.phone = w.phone) OR (w.email IS NOT NULL AND r.email = w.email))
     )
   ORDER BY w.created_at
$$;

CREATE FUNCTION queue_waitlist_batch(p_campaign TEXT, p_by TEXT, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  made UUID;
  n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('broadcast:' || p_campaign));

  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'send to at least one person' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM waitlist_unsent(p_campaign)) THEN
    RAISE EXCEPTION 'everyone on the waitlist has already had this' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO broadcasts (campaign, kind, created_by)
  VALUES (p_campaign, 'live', p_by)
  RETURNING id INTO made;

  INSERT INTO broadcast_recipients (broadcast_id, phone, email, wa_status, email_status)
  SELECT made, u.phone, u.email,
         CASE WHEN u.phone IS NULL THEN 'skipped' ELSE 'pending' END,
         CASE WHEN u.email IS NULL THEN 'skipped' ELSE 'pending' END
    FROM (SELECT * FROM waitlist_unsent(p_campaign) LIMIT p_limit) u
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION waitlist_unsent(TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION queue_waitlist_batch(TEXT, TEXT, INTEGER) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION waitlist_unsent(TEXT) FROM anon;
    REVOKE ALL ON FUNCTION queue_waitlist_batch(TEXT, TEXT, INTEGER) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION waitlist_unsent(TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION queue_waitlist_batch(TEXT, TEXT, INTEGER) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION waitlist_unsent(TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION queue_waitlist_batch(TEXT, TEXT, INTEGER) TO service_role;
  END IF;
END
$$;
