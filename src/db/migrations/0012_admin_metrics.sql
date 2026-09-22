-- The six numbers that decide whether the campaigns are working.
--
-- A view rather than queries in the admin app, so there is one definition of
-- "active user" and "payment rate" and the dashboard cannot quietly disagree
-- with anything else that asks. The admin reads it through Supabase as an
-- ordinary one-row table.
--
-- Everything is a 30-day window rather than a calendar month, so the numbers
-- mean the same thing on the 2nd as on the 28th.

CREATE VIEW admin_metrics AS
WITH
active AS (
  -- Active means they did something, not that they signed up. A signup who
  -- never sent an invoice is an acquisition cost, not a user.
  SELECT DISTINCT d.user_id
    FROM documents d
   WHERE d.status <> 'draft'
     AND d.created_at > now() - interval '30 days'
),
pro AS (
  SELECT DISTINCT s.user_id
    FROM subscriptions s
   WHERE s.status = 'active' AND s.period_end > now()
),
lapsed AS (
  -- Subscriptions that ended in the window and were not replaced: the closest
  -- thing to churn without a full subscription history.
  SELECT DISTINCT s.user_id
    FROM subscriptions s
   WHERE s.period_end BETWEEN now() - interval '30 days' AND now()
     AND NOT EXISTS (
       SELECT 1 FROM subscriptions n
        WHERE n.user_id = s.user_id AND n.period_end > now()
     )
),
docs AS (
  SELECT
    count(*)                                            AS sent,
    count(*) FILTER (WHERE status = 'paid')             AS paid,
    coalesce(avg(total_kobo), 0)                        AS avg_kobo,
    coalesce(sum(total_kobo), 0)                        AS billed_kobo
  FROM documents
  WHERE status <> 'draft'
    AND created_at > now() - interval '30 days'
),
earned AS (
  SELECT coalesce(sum(amount_kobo), 0) AS fees_kobo
    FROM fee_ledger
   WHERE created_at > now() - interval '30 days'
),
spend AS (
  SELECT coalesce(sum(cost_estimate_kobo), 0) AS messages_kobo
    FROM messages
   WHERE direction = 'out' AND created_at > now() - interval '30 days'
)
SELECT
  (SELECT count(*) FROM users WHERE status = 'active')            AS users_total,
  (SELECT count(*) FROM active)                                   AS users_active,
  (SELECT count(*) FROM pro)                                      AS pro_active,
  (SELECT count(*) FROM lapsed)                                   AS pro_lapsed_30d,

  -- Share of active users on Pro. Null rather than zero when nobody is
  -- active, because 0% and "no data yet" are different things.
  CASE WHEN (SELECT count(*) FROM active) > 0
       THEN round(100.0 * (SELECT count(*) FROM pro) / (SELECT count(*) FROM active), 1)
  END                                                             AS pro_conversion_pct,

  docs.sent                                                       AS documents_30d,
  docs.paid                                                       AS documents_paid_30d,
  CASE WHEN docs.sent > 0
       THEN round(100.0 * docs.paid / docs.sent, 1)
  END                                                             AS payment_rate_pct,

  round(docs.avg_kobo / 100.0, 2)                                 AS avg_invoice_naira,
  round(docs.billed_kobo / 100.0, 2)                              AS billed_naira_30d,

  -- Invoices per Pro user: the early warning. Under five a month they are
  -- paying ₦4,000 for what the free plan already gives them.
  CASE WHEN (SELECT count(*) FROM pro) > 0
       THEN round(docs.sent::numeric / (SELECT count(*) FROM pro), 1)
  END                                                             AS docs_per_pro_user,

  round(earned.fees_kobo / 100.0, 2)                              AS fees_earned_naira_30d,
  round(spend.messages_kobo / 100.0, 2)                           AS message_cost_naira_30d,
  round((earned.fees_kobo - spend.messages_kobo) / 100.0, 2)      AS contribution_naira_30d
FROM docs, earned, spend;

COMMENT ON VIEW admin_metrics IS
  'Six-metric dashboard over a rolling 30 days. One row, always.';
