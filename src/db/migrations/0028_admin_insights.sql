-- Everything else the admin shows: the funnel, how people use it, and the
-- breakdowns. One row, like admin_overview; the breakdowns are JSON arrays of
-- {k, n} (and kobo where money is involved), newest-first where that matters.
--
-- Same rules as 0027: definitions live here, the admin only lays them out,
-- and the view is security_invoker and closed to the public roles.

CREATE VIEW admin_insights WITH (security_invoker = true) AS
WITH
u   AS (SELECT * FROM users WHERE deleted_at IS NULL),
d   AS (SELECT * FROM documents WHERE status <> 'draft' AND type <> 'sample'),
inv AS (SELECT * FROM d WHERE type IN ('invoice', 'payment_request') AND status <> 'cancelled'),
p   AS (SELECT * FROM payments WHERE status = 'success'),
first_doc  AS (SELECT user_id, min(created_at) AS at FROM d GROUP BY user_id),
first_paid AS (SELECT DISTINCT user_id FROM inv WHERE amount_paid_kobo > 0)
SELECT
  -- The funnel, each step a subset of the one before it in practice.
  (SELECT count(*) FROM u)                                                 AS funnel_signed_up,
  (SELECT count(*) FROM u WHERE email_verified_at IS NOT NULL)             AS funnel_email_verified,
  (SELECT count(*) FROM u WHERE consented_at IS NOT NULL)                  AS funnel_set_up,
  (SELECT count(*) FROM first_doc)                                         AS funnel_first_document,
  (SELECT count(*) FROM first_paid)                                        AS funnel_first_paid,
  (SELECT count(DISTINCT user_id) FROM subscriptions WHERE amount_collected_kobo > 0) AS funnel_ever_pro,

  -- How fast people get somewhere.
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY f.at - u.created_at)) / 60)
     FROM first_doc f JOIN u ON u.id = f.user_id)                          AS median_minutes_to_first_document,
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY paid_at - sent_at)) / 3600, 1)
     FROM inv WHERE status = 'paid' AND paid_at IS NOT NULL AND sent_at IS NOT NULL) AS median_hours_to_paid,

  -- Who is around.
  (SELECT count(DISTINCT user_id) FROM messages WHERE direction = 'in' AND created_at > now() - interval '24 hours') AS users_messaging_24h,
  (SELECT count(DISTINCT user_id) FROM messages WHERE direction = 'in' AND created_at > now() - interval '7 days')   AS users_messaging_7d,
  (SELECT count(DISTINCT user_id) FROM messages WHERE direction = 'in' AND created_at > now() - interval '30 days')  AS users_messaging_30d,

  -- Invoice size.
  (SELECT coalesce(round(avg(total_kobo)), 0) FROM inv)                                          AS avg_invoice_kobo,
  (SELECT coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_kobo)), 0) FROM inv)  AS median_invoice_kobo,
  (SELECT coalesce(max(total_kobo), 0) FROM inv)                                                 AS largest_invoice_kobo,
  (SELECT CASE WHEN count(DISTINCT user_id) > 0 THEN round(count(*)::numeric / count(DISTINCT user_id), 1) END
     FROM d WHERE created_at > now() - interval '30 days')                                       AS documents_per_active_user_30d,

  -- How clients pay.
  (SELECT count(*) FROM p WHERE provider = 'paystack')                     AS payments_by_card,
  (SELECT count(*) FROM p WHERE provider <> 'paystack')                    AS payments_by_transfer,
  (SELECT coalesce(sum(client_total_kobo), 0) FROM p WHERE provider <> 'paystack') AS collected_by_transfer_kobo,
  (SELECT count(*) FROM payments WHERE status IN ('failed', 'needs_review', 'disputed')) AS payments_troubled,
  (SELECT count(*) FROM receipts)                                          AS receipts_issued,

  -- Clients.
  (SELECT count(*) FROM clients WHERE deleted_at IS NULL)                  AS clients_total,
  (SELECT count(*) FROM clients WHERE deleted_at IS NULL AND email IS NOT NULL AND email <> '') AS clients_with_email,
  (SELECT count(*) FROM clients WHERE deleted_at IS NULL AND phone IS NOT NULL AND phone <> '') AS clients_with_phone,

  -- WhatsApp traffic.
  (SELECT count(*) FROM messages WHERE direction = 'in'  AND created_at > now() - interval '30 days') AS messages_in_30d,
  (SELECT count(*) FROM messages WHERE direction = 'out' AND created_at > now() - interval '30 days') AS messages_out_30d,
  (SELECT count(*) FROM messages WHERE direction = 'out' AND template IS NOT NULL
     AND created_at > now() - interval '30 days')                          AS templates_out_30d,

  -- Reminders.
  (SELECT count(*) FROM reminders WHERE status = 'sent' AND sent_at > now() - interval '30 days') AS reminders_sent_30d,
  (SELECT count(*) FROM reminders WHERE status = 'pending')                AS reminders_pending,
  (SELECT count(*) FROM reminders WHERE status = 'failed')                 AS reminders_failed,

  -- Growth loops and trouble.
  (SELECT count(*) FROM referrals)                                         AS referrals_total,
  (SELECT count(*) FROM referrals WHERE credited_at IS NOT NULL)           AS referrals_credited,
  (SELECT count(*) FROM risk_flags WHERE status = 'open')                  AS risk_flags_open,

  -- The parser.
  (SELECT count(*) FROM parser_logs WHERE created_at > now() - interval '30 days')                  AS parses_30d,
  (SELECT round(avg(latency_ms)) FROM parser_logs WHERE created_at > now() - interval '30 days')    AS parser_avg_ms,

  -- Breakdowns.
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT status::text AS k, count(*) AS n FROM d GROUP BY 1) s)                          AS documents_by_status,
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n, 'kobo', kobo) ORDER BY n DESC), '[]'::json)
     FROM (SELECT currency::text AS k, count(*) AS n, sum(total_kobo) AS kobo FROM d GROUP BY 1) s) AS documents_by_currency,
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT coalesce(template_id, 'default') AS k, count(*) AS n FROM u GROUP BY 1) s)      AS designs,
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT coalesce(nullif(source, ''), 'direct') AS k, count(*) AS n FROM waitlist GROUP BY 1) s) AS waitlist_sources,
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT coalesce(template, 'free-form reply') AS k, count(*) AS n FROM messages
            WHERE direction = 'out' AND created_at > now() - interval '30 days' GROUP BY 1) s)    AS messages_by_kind_30d,
  (SELECT coalesce(json_agg(json_build_object('k', k, 'n', n) ORDER BY k), '[]'::json)
     FROM (SELECT extract(hour FROM created_at AT TIME ZONE 'Africa/Lagos')::int AS k, count(*) AS n
             FROM d GROUP BY 1) s)                                                                AS documents_by_hour;

COMMENT ON VIEW admin_insights IS 'Funnel, usage and breakdowns, for the admin dashboard.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_insights FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_insights FROM authenticated;
  END IF;
END
$$;
