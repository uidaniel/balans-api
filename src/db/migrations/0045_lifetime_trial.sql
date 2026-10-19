-- Three documents, ever, with everything (19 October 2026).
--
-- Free used to be three documents a calendar month without the Pro features.
-- It is now a trial: every account gets every Pro feature for its first
-- three sent documents, and after that a new document needs Pro. There is
-- no monthly reset.
--
-- `documents.trial` says a document was made on the trial rather than on a
-- paid month. A sent one counts towards the three whatever happens to it
-- next: cancelling does not give it back, or cancel-and-resend would be an
-- unlimited plan. Drafts do not count, and neither do changes to a sent
-- document. Every document that exists before this migration is `false`,
-- which is the reset: everybody starts with three.
--
-- A trial document keeps its Pro treatment for good (its logo, its colour,
-- its reminders), because there are at most three of them and they are what
-- the trial is showing. A document made on a paid month keeps it while the
-- account is paying, and loses it when Pro lapses.

ALTER TABLE users ADD COLUMN trial_documents INTEGER NOT NULL DEFAULT 3
  CHECK (trial_documents >= 0);
ALTER TABLE documents ADD COLUMN trial BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX documents_trial_by_user ON documents (user_id) WHERE trial;

-- Paying, or in the grace week after a paid month ran out. The 7 is
-- GRACE_DAYS in src/billing/subscription.ts; trial.test.ts holds them together.
CREATE FUNCTION balans_paid(u users) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT u.plan = 'pro'
       AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= now() - interval '7 days')
  $$;

-- Trial documents sent so far, cancelled ones included. An invoice made
-- from a quote has the quote as its parent and is not counted again.
CREATE FUNCTION balans_trial_used(user_id uuid) RETURNS integer
  LANGUAGE sql STABLE AS $$
    SELECT count(*)::int FROM documents d
     WHERE d.user_id = balans_trial_used.user_id
       AND d.trial AND d.type <> 'sample' AND d.status <> 'draft'
       AND d.parent_id IS NULL
  $$;

-- The account's features (designs, logo, colour, currencies, no fee): paying,
-- or trial documents left to send.
CREATE FUNCTION balans_pro(u users) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT balans_paid(u) OR balans_trial_used(u.id) < u.trial_documents
  $$;

-- One document's treatment (its page, PDF, emails and reminders).
CREATE FUNCTION balans_doc_pro(d documents, u users) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT d.trial OR balans_paid(u)
  $$;

-- Only the API calls these, as the owner. Nothing in them is for the anon key.
REVOKE EXECUTE ON FUNCTION balans_paid(users), balans_trial_used(uuid), balans_pro(users),
  balans_doc_pro(documents, users) FROM PUBLIC;
