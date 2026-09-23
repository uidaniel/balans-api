-- Looking one invoice up, by the reference printed on it.
--
-- The support question is always the same shape: somebody says an invoice has
-- not been paid, and the only thing they can read out is what is on the
-- document. `number` cannot answer it — it restarts at 1 for every freelancer,
-- so "invoice 2" names one invoice per user on the platform. `ref` can, which
-- is why it exists.
--
-- A view rather than queries in the admin app, for the same reason as
-- admin_metrics: one definition of what staff may see, written where the data
-- is rather than in a page that could quietly widen it.
--
-- What is deliberately NOT here: the freelancer's WhatsApp number, their email
-- and their bank details. None of them is needed to answer "is this paid", and
-- a support screen is the easiest place in a company for personal data to end
-- up on somebody's shoulder-surfed laptop. The business name identifies the
-- account; anything more is a separate, deliberate lookup.
CREATE VIEW admin_documents AS
SELECT
  d.ref,
  d.number,
  d.type::text                                        AS type,
  d.status::text                                      AS status,
  u.business_name,
  c.name                                              AS client_name,
  round(d.total_kobo / 100.0, 2)                      AS total_naira,
  round(d.amount_paid_kobo / 100.0, 2)                AS paid_naira,
  round((d.total_kobo - d.amount_paid_kobo) / 100.0, 2) AS outstanding_naira,
  d.issue_date,
  d.due_date,
  d.sent_at,
  d.paid_at,
  -- The question behind the question. "Sent" and "viewed" both mean unpaid,
  -- and staff should not have to remember which statuses count as which.
  (d.amount_paid_kobo >= d.total_kobo AND d.total_kobo > 0) AS is_paid,
  (d.status IN ('sent', 'viewed') AND d.due_date < CURRENT_DATE) AS is_overdue
FROM documents d
JOIN users u   ON u.id = d.user_id
LEFT JOIN clients c ON c.id = d.client_id
WHERE d.ref IS NOT NULL;

COMMENT ON VIEW admin_documents IS
  'One row per sent document, found by the reference printed on it. No personal contact details.';
