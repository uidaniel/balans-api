-- What the admin dashboard reads: the business, every user, and the last 30 days.
--
-- Views rather than queries in the admin app, for the reason admin_metrics
-- gave: one definition of "unpaid", "MRR" and "collected", written where the
-- data is, so the dashboard cannot quietly disagree with anything else that
-- asks. Money stays in kobo; the admin formats it.
--
-- Every one is security_invoker and revoked from the public roles, which is
-- what 0026 had to add to the two views before these. See there for why.
--
-- What counts as what, once, here:
--   an invoice      invoices and payment requests — both ask to be paid.
--                   Quotes are counted, but never in money owed or collected.
--   unpaid          sent, viewed, overdue or part paid. Not draft, not
--                   cancelled, not paid.
--   overdue         unpaid and past its due date, whatever its status says:
--                   the status only changes when the nightly job runs.
--   collected       what clients actually paid, by successful payment —
--                   including any fee passed on to them.
--   MRR             the price of every subscription in force right now.

CREATE VIEW admin_overview WITH (security_invoker = true) AS
WITH
u   AS (SELECT * FROM users WHERE deleted_at IS NULL),
d   AS (SELECT * FROM documents WHERE status <> 'draft' AND type <> 'sample'),
inv AS (SELECT * FROM d WHERE type IN ('invoice', 'payment_request') AND status <> 'cancelled'),
p   AS (
  SELECT *, coalesce(paid_at, created_at) AS at
    FROM payments WHERE status = 'success'
),
pro AS (
  SELECT DISTINCT ON (user_id) user_id, price_kobo
    FROM subscriptions
   WHERE status = 'active' AND period_end > now()
   ORDER BY user_id, period_end DESC
)
SELECT
  -- People
  (SELECT count(*) FROM u)                                                        AS users_total,
  (SELECT count(*) FROM u WHERE consented_at IS NOT NULL)                         AS users_onboarded,
  (SELECT count(*) FROM u WHERE created_at > now() - interval '6 hours')          AS signups_6h,
  (SELECT count(*) FROM u WHERE created_at > now() - interval '12 hours')         AS signups_12h,
  (SELECT count(*) FROM u WHERE created_at > now() - interval '24 hours')         AS signups_24h,
  (SELECT count(*) FROM u WHERE created_at > now() - interval '7 days')           AS signups_7d,
  (SELECT count(*) FROM u WHERE created_at > now() - interval '30 days')          AS signups_30d,
  (SELECT count(DISTINCT user_id) FROM d WHERE created_at > now() - interval '30 days') AS users_active_30d,
  (SELECT count(*) FROM waitlist)                                                 AS waitlist_total,

  -- Pro
  (SELECT count(*) FROM pro)                                                      AS pro_users,
  (SELECT coalesce(sum(price_kobo), 0) FROM pro)                                  AS mrr_kobo,

  -- Documents
  (SELECT count(*) FROM d WHERE created_at > now() - interval '6 hours')          AS documents_6h,
  (SELECT count(*) FROM d WHERE created_at > now() - interval '12 hours')         AS documents_12h,
  (SELECT count(*) FROM d WHERE created_at > now() - interval '24 hours')         AS documents_24h,
  (SELECT count(*) FROM d WHERE created_at > now() - interval '7 days')           AS documents_7d,
  (SELECT count(*) FROM d WHERE created_at > now() - interval '30 days')          AS documents_30d,
  (SELECT count(*) FROM d)                                                        AS documents_total,
  (SELECT count(*) FROM d WHERE type = 'invoice')                                 AS invoices_total,
  (SELECT count(*) FROM d WHERE type = 'quote')                                   AS quotes_total,
  (SELECT count(*) FROM d WHERE type = 'payment_request')                         AS requests_total,
  (SELECT count(*) FROM d WHERE currency <> 'NGN')                                AS foreign_documents,

  -- Invoices, by outcome
  (SELECT count(*) FROM inv WHERE status = 'paid')                                AS invoices_paid,
  (SELECT count(*) FROM inv WHERE status IN ('sent', 'viewed', 'overdue', 'part_paid')) AS invoices_unpaid,
  (SELECT count(*) FROM inv WHERE status = 'part_paid')                           AS invoices_part_paid,
  (SELECT count(*) FROM inv
    WHERE status IN ('sent', 'viewed', 'overdue', 'part_paid') AND due_date < CURRENT_DATE) AS invoices_overdue,

  -- Money
  (SELECT coalesce(sum(total_kobo), 0) FROM inv)                                  AS invoiced_kobo,
  (SELECT coalesce(sum(total_kobo), 0) FROM inv WHERE created_at > now() - interval '30 days') AS invoiced_30d_kobo,
  (SELECT coalesce(sum(total_kobo - amount_paid_kobo), 0) FROM inv
    WHERE status IN ('sent', 'viewed', 'overdue', 'part_paid'))                   AS outstanding_kobo,
  (SELECT count(*) FROM p)                                                        AS payments_count,
  (SELECT coalesce(sum(client_total_kobo), 0) FROM p)                             AS collected_kobo,
  (SELECT coalesce(sum(client_total_kobo), 0) FROM p WHERE at > now() - interval '24 hours') AS collected_24h_kobo,
  (SELECT coalesce(sum(client_total_kobo), 0) FROM p WHERE at > now() - interval '30 days')  AS collected_30d_kobo,
  (SELECT coalesce(sum(client_total_kobo), 0) FROM p WHERE provider = 'paystack') AS collected_by_card_kobo,
  (SELECT coalesce(sum(provider_fee_kobo), 0) FROM p)                             AS processor_fees_kobo,

  -- What Balans earns, and what it spends to earn it
  (SELECT coalesce(sum(amount_kobo), 0) FROM fee_ledger WHERE type = 'transaction_fee') AS earned_fees_kobo,
  (SELECT coalesce(sum(amount_kobo), 0) FROM fee_ledger WHERE type = 'subscription')    AS earned_subscriptions_kobo,
  (SELECT coalesce(sum(amount_kobo), 0) FROM fee_ledger
    WHERE created_at > now() - interval '30 days')                                AS earned_30d_kobo,
  (SELECT coalesce(sum(cost_estimate_kobo), 0) FROM messages
    WHERE direction = 'out' AND created_at > now() - interval '30 days')          AS message_cost_30d_kobo,
  (SELECT count(*) FROM messages
    WHERE direction = 'out' AND created_at > now() - interval '24 hours')         AS messages_out_24h;

COMMENT ON VIEW admin_overview IS 'The whole business in one row, for the admin dashboard.';

-- Every user, with what they have billed and been paid.
--
-- The WhatsApp number and email are here, unlike admin_documents: this is the
-- list staff use to find and contact a user, which the invoice lookup is not.
-- It is read only by the admin, behind the allowlist, with the service key.
CREATE VIEW admin_accounts WITH (security_invoker = true) AS
SELECT
  u.id,
  u.wa_phone,
  u.business_name,
  u.email,
  (u.email_verified_at IS NOT NULL)                                  AS email_verified,
  u.plan::text                                                       AS plan,
  u.status::text                                                     AS status,
  u.created_at,
  u.consented_at                                                     AS onboarded_at,
  (SELECT c.updated_at FROM conversations c WHERE c.user_id = u.id)  AS last_active_at,
  count(d.id) FILTER (WHERE d.status <> 'draft' AND d.type <> 'sample')                  AS documents,
  count(d.id) FILTER (WHERE d.type IN ('invoice', 'payment_request')
                        AND d.status NOT IN ('draft', 'cancelled'))                      AS invoices,
  count(d.id) FILTER (WHERE d.type IN ('invoice', 'payment_request') AND d.status = 'paid') AS invoices_paid,
  count(d.id) FILTER (WHERE d.type IN ('invoice', 'payment_request')
                        AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid'))      AS invoices_unpaid,
  coalesce(sum(d.total_kobo) FILTER (WHERE d.type IN ('invoice', 'payment_request')
                                       AND d.status NOT IN ('draft', 'cancelled')), 0)   AS invoiced_kobo,
  coalesce(sum(d.amount_paid_kobo) FILTER (WHERE d.type IN ('invoice', 'payment_request')), 0) AS collected_kobo,
  coalesce(sum(d.total_kobo - d.amount_paid_kobo)
             FILTER (WHERE d.type IN ('invoice', 'payment_request')
                       AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid')), 0)   AS outstanding_kobo,
  max(d.created_at) FILTER (WHERE d.status <> 'draft')                                   AS last_document_at
FROM users u
LEFT JOIN documents d ON d.user_id = u.id
WHERE u.deleted_at IS NULL
GROUP BY u.id;

COMMENT ON VIEW admin_accounts IS 'One row per user, with their billing totals.';

-- The last 30 days, one row a day, in Lagos days.
CREATE VIEW admin_daily WITH (security_invoker = true) AS
WITH days AS (
  SELECT generate_series(
           (now() AT TIME ZONE 'Africa/Lagos')::date - 29,
           (now() AT TIME ZONE 'Africa/Lagos')::date,
           interval '1 day'
         )::date AS day
)
SELECT
  days.day,
  (SELECT count(*) FROM users u
    WHERE (u.created_at AT TIME ZONE 'Africa/Lagos')::date = days.day)                  AS signups,
  (SELECT count(*) FROM documents d
    WHERE d.status <> 'draft' AND d.type <> 'sample'
      AND (d.created_at AT TIME ZONE 'Africa/Lagos')::date = days.day)                  AS documents,
  (SELECT coalesce(sum(d.total_kobo), 0) FROM documents d
    WHERE d.type IN ('invoice', 'payment_request') AND d.status NOT IN ('draft', 'cancelled')
      AND (d.created_at AT TIME ZONE 'Africa/Lagos')::date = days.day)                  AS invoiced_kobo,
  (SELECT count(*) FROM payments p
    WHERE p.status = 'success'
      AND (coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Africa/Lagos')::date = days.day) AS payments,
  (SELECT coalesce(sum(p.client_total_kobo), 0) FROM payments p
    WHERE p.status = 'success'
      AND (coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Africa/Lagos')::date = days.day) AS collected_kobo
FROM days
ORDER BY days.day;

COMMENT ON VIEW admin_daily IS 'Signups, documents and money per Lagos day, for the last 30 days.';

-- Payments, newest first: the ledger staff read when somebody says they paid.
CREATE VIEW admin_payments WITH (security_invoker = true) AS
SELECT
  p.id,
  p.reference,
  p.provider,
  p.status::text                          AS status,
  p.client_total_kobo,
  p.amount_kobo                           AS to_user_kobo,
  p.provider_fee_kobo,
  p.balans_fee_kobo,
  coalesce(p.paid_at, p.created_at)       AS at,
  d.ref                                   AS document_ref,
  d.currency,
  u.business_name,
  c.name                                  AS client_name
FROM payments p
JOIN documents d ON d.id = p.document_id
JOIN users u     ON u.id = d.user_id
LEFT JOIN clients c ON c.id = d.client_id;

COMMENT ON VIEW admin_payments IS 'Every payment with who it was for and from.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_overview, admin_accounts, admin_daily, admin_payments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_overview, admin_accounts, admin_daily, admin_payments FROM authenticated;
  END IF;
END
$$;
