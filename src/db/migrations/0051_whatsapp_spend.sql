-- What WhatsApp actually costs, from Meta rather than from our guess (30 October 2026).
--
-- Until now the admin added up `messages.cost_estimate_kobo`: a fixed price
-- per message written at send time. Meta says what really happened in two
-- places, and both are now kept:
--
--   whatsapp_billing  Every delivery report Meta sends carries a `pricing`
--                     block: was this message billable, in which category
--                     (marketing, utility, authentication, service), and if
--                     free, why (inside the service window, from an ad).
--                     Those reports are already stored whole in
--                     `webhook_events`, so this view reads them from launch
--                     on: exact counts, no estimate.
--
--   whatsapp_spend    What Meta charged, by day, category and type, from its
--                     pricing analytics (whatsapp/spend.ts, synced by the
--                     hourly jobs). Meta reports in the account's currency;
--                     `cost_kobo` is that in naira at the rate on the day it
--                     was synced, and null when there was no rate to use.
--
-- admin_whatsapp puts both in one row for the dashboard. Where Meta has not
-- reported a day yet, it says so (`spend_reported_through`) rather than
-- filling the gap with an estimate.

CREATE TABLE whatsapp_spend (
  day              DATE NOT NULL,
  pricing_category TEXT NOT NULL,
  pricing_type     TEXT NOT NULL,
  country          TEXT NOT NULL DEFAULT '',
  volume           INTEGER NOT NULL,
  cost             NUMERIC(14, 6) NOT NULL,
  currency         TEXT NOT NULL,
  cost_kobo        BIGINT,
  fx_rate          NUMERIC(14, 6),
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, pricing_category, pricing_type, country)
);

ALTER TABLE whatsapp_spend ENABLE ROW LEVEL SECURITY;

-- One row per message Meta has priced: the first delivery report that
-- carried a price. Message ids are the event id up to the status.
CREATE VIEW whatsapp_billing WITH (security_invoker = true) AS
SELECT DISTINCT ON (split_part(e.event_id, ':', 1))
  split_part(e.event_id, ':', 1)                                    AS wa_message_id,
  e.received_at                                                     AS priced_at,
  (e.payload_json -> 'status' -> 'pricing' ->> 'billable')::boolean AS billable,
  lower(e.payload_json -> 'status' -> 'pricing' ->> 'category')     AS category,
  lower(e.payload_json -> 'status' -> 'pricing' ->> 'type')         AS pricing_type,
  e.payload_json -> 'status' -> 'pricing' ->> 'pricing_model'       AS pricing_model
FROM webhook_events e
WHERE e.provider = 'whatsapp'
  AND e.event_type LIKE 'status.%'
  AND e.payload_json -> 'status' ? 'pricing'
ORDER BY split_part(e.event_id, ':', 1), e.received_at;

COMMENT ON VIEW whatsapp_billing IS 'Every message Meta priced, from its delivery reports. Exact, not estimated.';

CREATE VIEW admin_whatsapp WITH (security_invoker = true) AS
WITH
today AS (SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS d),
s AS (SELECT * FROM whatsapp_spend WHERE day > (SELECT d FROM today) - 30),
b AS (SELECT * FROM whatsapp_billing WHERE priced_at > now() - interval '30 days')
SELECT
  -- What Meta charged. Null when Meta has reported nothing for the period:
  -- "not reported" and "free" are different answers.
  (SELECT sum(cost_kobo) FROM s)                                    AS spend_30d_kobo,
  (SELECT sum(cost) FROM s)                                         AS spend_30d,
  (SELECT min(currency) FROM s)                                     AS spend_currency,
  (SELECT count(*) FROM s WHERE cost_kobo IS NULL AND cost > 0)     AS spend_unconverted_days,
  (SELECT max(day) FROM whatsapp_spend)                             AS spend_reported_through,
  (SELECT max(fetched_at) FROM whatsapp_spend)                      AS spend_synced_at,
  (SELECT coalesce(sum(volume), 0) FROM s)                          AS reported_messages_30d,

  -- What Meta priced, message by message, from its delivery reports.
  (SELECT count(*) FROM b)                                          AS priced_messages_30d,
  (SELECT count(*) FROM b WHERE billable)                           AS billable_messages_30d,
  (SELECT count(*) FROM b WHERE NOT billable)                       AS free_messages_30d,

  -- Everything we sent, priced or not (a failed send never is).
  (SELECT count(*) FROM messages
    WHERE direction = 'out' AND status = 'sent' AND created_at > now() - interval '30 days') AS sent_messages_30d,

  -- By category and type, from both sides.
  coalesce((
    SELECT jsonb_agg(x ORDER BY x.messages DESC)
      FROM (SELECT category, pricing_type, count(*) AS messages, count(*) FILTER (WHERE billable) AS billable
              FROM b GROUP BY 1, 2) x
  ), '[]'::jsonb)                                                   AS priced_by_category,
  coalesce((
    SELECT jsonb_agg(x ORDER BY x.cost_kobo DESC NULLS LAST)
      FROM (SELECT lower(pricing_category) AS category, lower(pricing_type) AS pricing_type,
                   sum(volume) AS messages, sum(cost) AS cost, sum(cost_kobo) AS cost_kobo
              FROM s GROUP BY 1, 2) x
  ), '[]'::jsonb)                                                   AS spend_by_category,

  -- The last 30 Lagos days, for a chart: what Meta charged and how many it billed.
  (SELECT jsonb_agg(jsonb_build_object(
            'day', d.day,
            'cost_kobo', (SELECT sum(cost_kobo) FROM whatsapp_spend w WHERE w.day = d.day),
            'reported', EXISTS (SELECT 1 FROM whatsapp_spend w WHERE w.day = d.day),
            'billable', (SELECT count(*) FROM b WHERE b.billable
                            AND (b.priced_at AT TIME ZONE 'Africa/Lagos')::date = d.day))
          ORDER BY d.day)
     FROM (SELECT generate_series((SELECT d FROM today) - 29, (SELECT d FROM today), interval '1 day')::date AS day) d
  )                                                                 AS daily;

COMMENT ON VIEW admin_whatsapp IS 'WhatsApp spend and volumes as Meta reports them. One row, always.';

-- No grants to the public roles, as for every admin view (see 0026).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON whatsapp_spend, whatsapp_billing, admin_whatsapp FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON whatsapp_spend, whatsapp_billing, admin_whatsapp FROM authenticated;
  END IF;
END
$$;
