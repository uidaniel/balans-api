-- Test data out of the numbers (5 November 2026).
--
-- The founders, and people they asked, tried Balans on live: invoices to
-- themselves, clients called "test", a ₦10,000,000 invoice. Every total in
-- the admin counted them. Now an account can be marked as a test, and a single
-- invoice left out, from the admin (both written to audit_log there), and
-- the admin lists what looks like a test for somebody to decide on
-- (admin_suspect_documents). Nothing is deleted: a mark can be taken back.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS left_out boolean NOT NULL DEFAULT false;

-- The real ones: what every total reads instead of the tables themselves.
CREATE OR REPLACE VIEW real_users WITH (security_invoker = true) AS
  SELECT * FROM users WHERE NOT is_test;
CREATE OR REPLACE VIEW real_documents WITH (security_invoker = true) AS
  SELECT d.* FROM documents d
   WHERE NOT d.left_out
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id AND u.is_test);
-- And what hangs off them: money, fees, Pro, receipts and reminders.
CREATE OR REPLACE VIEW real_payments WITH (security_invoker = true) AS
  SELECT p.* FROM payments p WHERE EXISTS (SELECT 1 FROM real_documents d WHERE d.id = p.document_id);
CREATE OR REPLACE VIEW real_fee_ledger WITH (security_invoker = true) AS
  SELECT f.* FROM fee_ledger f WHERE EXISTS (SELECT 1 FROM real_users u WHERE u.id = f.user_id);
CREATE OR REPLACE VIEW real_subscriptions WITH (security_invoker = true) AS
  SELECT s.* FROM subscriptions s WHERE EXISTS (SELECT 1 FROM real_users u WHERE u.id = s.user_id);
CREATE OR REPLACE VIEW real_receipts WITH (security_invoker = true) AS
  SELECT r.* FROM receipts r WHERE EXISTS (SELECT 1 FROM real_payments p WHERE p.id = r.payment_id);
CREATE OR REPLACE VIEW real_reminders WITH (security_invoker = true) AS
  SELECT r.* FROM reminders r WHERE EXISTS (SELECT 1 FROM real_documents d WHERE d.id = r.document_id);

-- Every view that adds things up reads the real ones from now on (users,
-- documents, payments, fees, subscriptions, receipts, reminders). The lists
-- (admin_accounts, admin_documents, admin_payments) keep everything, so a
-- test account can still be found and put back. Rewritten from each view's
-- own definition, so nothing else in them changes: a table with an alias
-- keeps it, and one without is given its own name as one, since the
-- definition names its columns by the table ("documents.sent_at").
DO $$
DECLARE
  v text;
  def text;
BEGIN
  FOREACH v IN ARRAY ARRAY['admin_activation', 'admin_active', 'admin_cohorts', 'admin_daily', 'admin_insights',
                           'admin_invoice_loop', 'admin_metrics', 'admin_overview', 'admin_weekly'] LOOP
    IF to_regclass(v) IS NULL THEN CONTINUE; END IF;
    def := pg_get_viewdef(to_regclass(v), false);
    -- With an alias: "FROM documents d" becomes "FROM real_documents d".
    def := regexp_replace(def, '\m(FROM|JOIN)(\s+)(?:[a-z_]+\.)?(users|documents|payments|fee_ledger|subscriptions|receipts|reminders)(\s+)([a-z_][a-z0-9_]*)\M', '\1\2real_\3\4\5', 'g');
    -- Without one, it keeps its own name: "FROM real_documents documents".
    def := regexp_replace(def, '\m(FROM|JOIN)(\s+)(?:[a-z_]+\.)?(users|documents|payments|fee_ledger|subscriptions|receipts|reminders)\M(?!\s+[a-z_])', '\1\2real_\3 \3', 'g');
    EXECUTE format('CREATE OR REPLACE VIEW %I WITH (security_invoker = true) AS %s', v, def);
  END LOOP;
END
$$;

-- How far people get through setup, counting only those who joined since
-- the steps were first written (0072), or every earlier sign-up would look
-- like somebody who never saw the welcome card.
CREATE OR REPLACE VIEW admin_setup_steps WITH (security_invoker = true) AS
  WITH started AS (
    SELECT id FROM users
     WHERE deleted_at IS NULL AND NOT is_test
       AND created_at > now() - interval '30 days'
       AND created_at >= COALESCE((SELECT min(at) FROM setup_steps), now())
  )
  SELECT s.step, count(*)::int AS people, min(s.at) AS first_at, max(s.at) AS last_at
    FROM setup_steps s JOIN started u ON u.id = s.user_id
   GROUP BY s.step
  UNION ALL
  SELECT 'started', count(*)::int, NULL, NULL FROM started
  UNION ALL
  SELECT 'finished', count(*)::int, NULL, NULL
    FROM users u JOIN started s ON s.id = u.id
   WHERE u.consented_at IS NOT NULL;

-- What looks like a test, for a person to decide on. Each reason is a rule;
-- none of them marks anything by itself.
CREATE OR REPLACE VIEW admin_suspect_documents WITH (security_invoker = true) AS
  SELECT * FROM (
    SELECT d.id AS document_id, d.user_id, d.number, d.type, d.total_kobo, d.created_at,
           c.name AS client_name, u.business_name,
           array_remove(ARRAY[
             CASE WHEN c.phone IS NOT NULL AND c.phone = u.wa_phone THEN 'sent to their own number' END,
             CASE WHEN c.name ~* '\mtest' THEN 'client called test' END,
             CASE WHEN u.business_name IS NOT NULL AND lower(btrim(c.name)) = lower(btrim(u.business_name)) THEN 'client is the business itself' END,
             CASE WHEN u.business_name ~* '\mtest' THEN 'business called test' END,
             CASE WHEN d.total_kobo >= 500000000 THEN 'over ₦5,000,000' END,
             CASE WHEN d.total_kobo < 50000 THEN 'under ₦500' END
           ], NULL) AS reasons
      FROM documents d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN clients c ON c.id = d.client_id
     WHERE d.status <> 'draft' AND d.type <> 'sample'
       AND NOT d.left_out AND NOT u.is_test AND u.deleted_at IS NULL
  ) s
  WHERE cardinality(reasons) > 0;

COMMENT ON VIEW admin_suspect_documents IS 'Invoices that look like tests, with why, for staff to mark or clear.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON real_users, real_documents, real_payments, real_fee_ledger, real_subscriptions, real_receipts, real_reminders, admin_suspect_documents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON real_users, real_documents, real_payments, real_fee_ledger, real_subscriptions, real_receipts, real_reminders, admin_suspect_documents FROM authenticated;
  END IF;
END
$$;
