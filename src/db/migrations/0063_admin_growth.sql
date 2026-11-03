-- Whether people stay, how fast they start, and whether invoices bring in
-- new users (3 November 2026), for the admin's Analytics page.
--
-- Same rules as 0027: definitions live here, the admin lays them out, and
-- every view is security_invoker and closed to the public roles.
--
--   sent a document   any document that left draft, samples aside, at the
--                     time it was sent (created, for older rows without one).
--   weeks             Monday to Sunday, Lagos time.
--   a user's week N   days 7N to 7N+6 after they finished setup; week 0 is
--                     their first seven days.

-- Each of the last twelve weeks: businesses that sent a document (the number
-- that says whether Balans is growing), and how many finished setup.
CREATE VIEW admin_weekly WITH (security_invoker = true) AS
WITH
d AS (
  SELECT user_id, (coalesce(sent_at, created_at) AT TIME ZONE 'Africa/Lagos') AS at
    FROM documents WHERE status <> 'draft' AND type <> 'sample'
),
w AS (
  SELECT generate_series(
           date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') - interval '11 weeks',
           date_trunc('week', now() AT TIME ZONE 'Africa/Lagos'),
           interval '1 week') AS week
)
SELECT
  w.week::date AS week,
  (SELECT count(DISTINCT user_id) FROM d WHERE d.at >= w.week AND d.at < w.week + interval '1 week')::int AS active,
  (SELECT count(*) FROM d WHERE d.at >= w.week AND d.at < w.week + interval '1 week')::int AS documents,
  (SELECT count(*) FROM users u
    WHERE u.deleted_at IS NULL
      AND (u.consented_at AT TIME ZONE 'Africa/Lagos') >= w.week
      AND (u.consented_at AT TIME ZONE 'Africa/Lagos') < w.week + interval '1 week')::int AS new_users
FROM w
ORDER BY w.week;

COMMENT ON VIEW admin_weekly IS 'Businesses that sent a document, and setups finished, per week for twelve weeks.';

-- The same, rolling, for the Overview's headline: the last seven days
-- against the seven before, so a Tuesday is not compared with a whole week.
CREATE VIEW admin_active WITH (security_invoker = true) AS
WITH d AS (
  SELECT user_id, coalesce(sent_at, created_at) AS at
    FROM documents WHERE status <> 'draft' AND type <> 'sample'
)
SELECT
  (SELECT count(DISTINCT user_id) FROM d WHERE at > now() - interval '7 days')::int  AS active_7d,
  (SELECT count(DISTINCT user_id) FROM d
    WHERE at > now() - interval '14 days' AND at <= now() - interval '7 days')::int  AS active_prev_7d,
  (SELECT count(DISTINCT user_id) FROM d WHERE at > now() - interval '30 days')::int AS active_30d;

COMMENT ON VIEW admin_active IS 'Businesses that sent a document in the last 7 days, the 7 before, and 30.';

-- People who finished setup in each of the last twelve weeks, and how many
-- of them sent a document in their week 0, 1, 2, 3, 4, 6 and 8.
-- `weeks_complete`: how many of those weeks every one of them has lived
-- through; a later week's figure is still filling in.
CREATE VIEW admin_cohorts WITH (security_invoker = true) AS
WITH
c AS (
  SELECT id, consented_at, date_trunc('week', consented_at AT TIME ZONE 'Africa/Lagos') AS cohort
    FROM users
   WHERE deleted_at IS NULL AND consented_at IS NOT NULL
),
a AS (
  SELECT c.id, array_agg(DISTINCT floor(extract(epoch FROM coalesce(d.sent_at, d.created_at) - c.consented_at) / 604800)::int) AS weeks
    FROM documents d JOIN c ON c.id = d.user_id
   WHERE d.status <> 'draft' AND d.type <> 'sample'
     AND coalesce(d.sent_at, d.created_at) >= c.consented_at
   GROUP BY c.id
)
SELECT
  c.cohort::date AS week,
  count(*)::int AS users,
  (floor(extract(epoch FROM (now() AT TIME ZONE 'Africa/Lagos') - c.cohort) / 604800) - 1)::int AS weeks_complete,
  count(*) FILTER (WHERE a.weeks @> ARRAY[0])::int AS w0,
  count(*) FILTER (WHERE a.weeks @> ARRAY[1])::int AS w1,
  count(*) FILTER (WHERE a.weeks @> ARRAY[2])::int AS w2,
  count(*) FILTER (WHERE a.weeks @> ARRAY[3])::int AS w3,
  count(*) FILTER (WHERE a.weeks @> ARRAY[4])::int AS w4,
  count(*) FILTER (WHERE a.weeks @> ARRAY[6])::int AS w6,
  count(*) FILTER (WHERE a.weeks @> ARRAY[8])::int AS w8
FROM c LEFT JOIN a ON a.id = c.id
WHERE c.cohort >= date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') - interval '11 weeks'
GROUP BY c.cohort
ORDER BY c.cohort DESC;

COMMENT ON VIEW admin_cohorts IS 'Each setup week''s people, and how many sent a document in their weeks 0 to 8.';

-- How fast people get going, one row. Each share is out of the people who
-- have had the time: "within 7 days" counts only those set up a week ago.
CREATE VIEW admin_activation WITH (security_invoker = true) AS
WITH
u AS (SELECT id, created_at, consented_at FROM users WHERE deleted_at IS NULL AND consented_at IS NOT NULL),
f AS (
  SELECT user_id, min(coalesce(sent_at, created_at)) AS at
    FROM documents WHERE status <> 'draft' AND type <> 'sample'
   GROUP BY user_id
),
p AS (
  SELECT d.user_id, min(coalesce(p.paid_at, p.created_at)) AS at
    FROM payments p JOIN documents d ON d.id = p.document_id
   WHERE p.status = 'success'
   GROUP BY d.user_id
),
x AS (
  SELECT u.*, f.at AS first_doc, p.at AS first_paid
    FROM u LEFT JOIN f ON f.user_id = u.id LEFT JOIN p ON p.user_id = u.id
)
SELECT
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY consented_at - created_at)) / 60)
     FROM x)::int                                                                        AS median_minutes_to_setup,
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY first_doc - consented_at)) / 60)
     FROM x WHERE first_doc >= consented_at)::int                                        AS median_minutes_to_first_doc,
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY first_paid - consented_at)) / 3600, 1)
     FROM x WHERE first_paid >= consented_at)::float                                     AS median_hours_to_first_paid,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '1 day')::int            AS set_up_1d,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '1 day'
      AND first_doc < consented_at + interval '1 day')::int                              AS first_doc_1d,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '7 days')::int           AS set_up_7d,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '7 days'
      AND first_doc < consented_at + interval '7 days')::int                             AS first_doc_7d,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '30 days')::int          AS set_up_30d,
  (SELECT count(*) FROM x WHERE consented_at < now() - interval '30 days'
      AND first_paid < consented_at + interval '30 days')::int                           AS first_paid_30d,
  (SELECT count(*) FROM x WHERE first_doc IS NULL)::int                                  AS never_sent;

COMMENT ON VIEW admin_activation IS 'How fast people who finished setup send their first document and get paid.';

-- Invoices as a way in: clients who opened one, then (from the "Made with
-- Balans" link, ref=invoice) tapped through, messaged and set up.
CREATE VIEW admin_invoice_loop WITH (security_invoker = true) AS
SELECT
  (SELECT count(*) FROM documents WHERE viewed_at > now() - interval '30 days' AND type <> 'sample')::int AS opened_30d,
  (SELECT count(*) FROM documents WHERE viewed_at IS NOT NULL AND type <> 'sample')::int                  AS opened_total,
  (SELECT count(*) FROM link_clicks WHERE ref = 'invoice')::int                                           AS taps,
  (SELECT count(*) FROM users WHERE deleted_at IS NULL AND signup_source = 'website' AND signup_detail = 'invoice')::int AS messaged,
  (SELECT count(*) FROM users WHERE deleted_at IS NULL AND signup_source = 'website' AND signup_detail = 'invoice'
      AND consented_at IS NOT NULL)::int                                                                  AS finished;

COMMENT ON VIEW admin_invoice_loop IS 'Clients who opened an invoice, tapped Made with Balans, and signed up themselves.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_weekly, admin_active, admin_cohorts, admin_activation, admin_invoice_loop FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_weekly, admin_active, admin_cohorts, admin_activation, admin_invoice_loop FROM authenticated;
  END IF;
END
$$;
