-- Balans initial schema (PRD section 7).
--
-- All money is integer kobo. All timestamps are UTC. All ids are UUID unless
-- noted. Soft-delete via deleted_at only where deletion is allowed.
--
-- Money columns are BIGINT, never NUMERIC or FLOAT: every amount in this system
-- is a whole number of kobo, and the one rule that is never negotiable is that
-- deterministic code — not a float, and not the language model — computes it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE plan_id            AS ENUM ('free', 'pro');
CREATE TYPE user_status        AS ENUM ('active', 'paused', 'closed');
CREATE TYPE risk_tier          AS ENUM ('new', 'established');
CREATE TYPE collection_method  AS ENUM ('link', 'deduct_from_invoice');
CREATE TYPE bank_account_status AS ENUM ('active', 'pending', 'retired');
CREATE TYPE document_type      AS ENUM ('quote', 'invoice', 'payment_request', 'sample');
CREATE TYPE document_status    AS ENUM (
  'draft', 'sent', 'viewed', 'overdue', 'part_paid', 'paid',
  'cancelled', 'accepted', 'converted', 'expired'
);
CREATE TYPE part_status        AS ENUM ('pending', 'payable', 'paid');
CREATE TYPE payment_status     AS ENUM (
  'initialised', 'success', 'failed', 'needs_review', 'disputed', 'refunded'
);
CREATE TYPE payment_method     AS ENUM ('online', 'offline');
CREATE TYPE fee_bearer         AS ENUM ('user', 'client');
CREATE TYPE fee_kind           AS ENUM ('transaction_fee', 'subscription');
CREATE TYPE message_direction  AS ENUM ('in', 'out');
CREATE TYPE email_status       AS ENUM ('unknown', 'valid', 'bounced', 'complained');

-- ---------------------------------------------------------------------------
-- Users and money destinations
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_phone                TEXT NOT NULL UNIQUE,
  business_name           TEXT,
  email                   TEXT,
  email_verified_at       TIMESTAMPTZ,
  plan                    plan_id NOT NULL DEFAULT 'free',
  plan_expires_at         TIMESTAMPTZ,
  plan_collection_method  collection_method,
  logo_url                TEXT,
  address                 TEXT,
  tin                     TEXT,
  default_due_days        INTEGER NOT NULL DEFAULT 7,
  default_pass_fees       BOOLEAN NOT NULL DEFAULT FALSE,
  referral_code           TEXT UNIQUE,
  referred_by             UUID REFERENCES users (id),
  status                  user_status NOT NULL DEFAULT 'active',
  risk_tier               risk_tier NOT NULL DEFAULT 'new',
  consent_version         TEXT,
  consented_at            TIMESTAMPTZ,
  activated_setup_at      TIMESTAMPTZ,
  first_paid_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

-- The account a user's share settles into. Only one may be active at a time; a
-- change is written as `pending` and promoted 24 hours later (F17), which is
-- why this is a table and not columns on `users`.
CREATE TABLE bank_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bank_code               TEXT NOT NULL,
  bank_name               TEXT NOT NULL,
  account_last4           TEXT NOT NULL,
  -- AES-256-GCM. The clear number is never stored and never logged.
  account_number_encrypted BYTEA NOT NULL,
  -- What the bank returned, not what the user typed.
  account_name            TEXT NOT NULL,
  provider                TEXT NOT NULL DEFAULT 'monnify',
  subaccount_code         TEXT,
  status                  bank_account_status NOT NULL DEFAULT 'pending',
  effective_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX bank_accounts_one_active
  ON bank_accounts (user_id) WHERE status = 'active';
CREATE INDEX bank_accounts_pending_due
  ON bank_accounts (effective_at) WHERE status = 'pending';

CREATE TABLE clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT,
  email_status email_status NOT NULL DEFAULT 'unknown',
  phone        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX clients_by_user ON clients (user_id) WHERE deleted_at IS NULL;
-- "Invoice Zenith again" has to find one client, so names are unique per user.
CREATE UNIQUE INDEX clients_name_per_user
  ON clients (user_id, lower(name)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id            UUID REFERENCES clients (id),
  type                 document_type NOT NULL,
  number               INTEGER NOT NULL,
  status               document_status NOT NULL DEFAULT 'draft',
  currency             TEXT NOT NULL DEFAULT 'NGN',
  subtotal_kobo        BIGINT NOT NULL DEFAULT 0,
  vat_kobo             BIGINT NOT NULL DEFAULT 0,
  total_kobo           BIGINT NOT NULL DEFAULT 0,
  amount_paid_kobo     BIGINT NOT NULL DEFAULT 0,
  pass_fees_to_client  BOOLEAN NOT NULL DEFAULT FALSE,
  issue_date           DATE,
  due_date             DATE,
  valid_until          DATE,
  notes                TEXT,
  -- Unguessable, from a CSPRNG (section 11). The only key a client needs.
  public_token         TEXT UNIQUE,
  parent_id            UUID REFERENCES documents (id),
  current_version      INTEGER NOT NULL DEFAULT 1,
  viewed_at            TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT documents_money_non_negative
    CHECK (subtotal_kobo >= 0 AND vat_kobo >= 0 AND total_kobo >= 0 AND amount_paid_kobo >= 0),
  -- Section 7: amount_paid_kobo never exceeds total_kobo.
  CONSTRAINT documents_paid_within_total
    CHECK (amount_paid_kobo <= total_kobo)
);

-- Section 7: numbers are unique per user and type, assigned in a transaction.
CREATE UNIQUE INDEX documents_number_per_user_type
  ON documents (user_id, type, number);
CREATE INDEX documents_by_user_status ON documents (user_id, status);
CREATE INDEX documents_overdue_sweep
  ON documents (due_date) WHERE status IN ('sent', 'viewed');

CREATE TABLE document_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  -- Everything the PDF was rendered from, so a reissue is byte-identical.
  snapshot_json JSONB NOT NULL,
  pdf_key       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  description      TEXT NOT NULL,
  qty              NUMERIC(12, 3) NOT NULL DEFAULT 1,
  unit_amount_kobo BIGINT NOT NULL,
  amount_kobo      BIGINT NOT NULL,
  UNIQUE (document_id, position),
  CONSTRAINT line_items_amounts_non_negative
    CHECK (unit_amount_kobo >= 0 AND amount_kobo >= 0)
);

-- Deposits and milestones. Only the next unpaid part is `payable`, so nobody
-- pays the wrong half.
CREATE TABLE payment_parts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  label       TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status      part_status NOT NULL DEFAULT 'pending',
  paid_at     TIMESTAMPTZ,
  UNIQUE (document_id, position)
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id                 UUID NOT NULL REFERENCES documents (id),
  part_id                     UUID REFERENCES payment_parts (id),
  provider                    TEXT NOT NULL DEFAULT 'monnify',
  -- Section 7: unique. Our idempotency key against replayed webhooks.
  reference                   TEXT NOT NULL UNIQUE,
  amount_kobo                 BIGINT NOT NULL,
  client_total_kobo           BIGINT NOT NULL,
  provider_fee_kobo           BIGINT NOT NULL DEFAULT 0,
  balans_fee_kobo             BIGINT NOT NULL DEFAULT 0,
  subscription_deduction_kobo BIGINT NOT NULL DEFAULT 0,
  fee_bearer                  fee_bearer NOT NULL DEFAULT 'user',
  channel                     TEXT,
  status                      payment_status NOT NULL DEFAULT 'initialised',
  method                      payment_method NOT NULL DEFAULT 'online',
  paid_at                     TIMESTAMPTZ,
  -- The provider's own verification response, kept for reconciliation.
  raw_verify_json             JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payments_amounts_non_negative
    CHECK (amount_kobo >= 0 AND client_total_kobo >= 0
       AND provider_fee_kobo >= 0 AND balans_fee_kobo >= 0
       AND subscription_deduction_kobo >= 0)
);

CREATE INDEX payments_by_document ON payments (document_id);
CREATE INDEX payments_reconcile ON payments (created_at) WHERE status = 'success';

CREATE TABLE receipts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  pdf_key    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan                   plan_id NOT NULL,
  period_start           TIMESTAMPTZ NOT NULL,
  period_end             TIMESTAMPTZ NOT NULL,
  price_kobo             BIGINT NOT NULL,
  collection_method      collection_method NOT NULL,
  amount_collected_kobo  BIGINT NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX subscriptions_by_user ON subscriptions (user_id, period_end DESC);

-- Every naira Balans earns, itemised. The source of truth for revenue.
CREATE TABLE fee_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id),
  payment_id  UUID REFERENCES payments (id),
  type        fee_kind NOT NULL,
  amount_kobo BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fee_ledger_by_created ON fee_ledger (created_at);

-- ---------------------------------------------------------------------------
-- Messaging, conversation, scheduling
-- ---------------------------------------------------------------------------

CREATE TABLE reminders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX reminders_due ON reminders (scheduled_at) WHERE status = 'pending';

CREATE TABLE recurring_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id     UUID REFERENCES clients (id),
  template_json JSONB NOT NULL,
  cadence       TEXT NOT NULL,
  next_run_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX recurring_due ON recurring_schedules (next_run_at) WHERE status = 'active';

-- One row per user: where the conversation stands (section 5).
CREATE TABLE conversations (
  user_id        UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'new',
  context_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES users (id) ON DELETE CASCADE,
  -- Meta's id. Unique, and the reason a redelivered webhook is a no-op.
  wa_message_id      TEXT UNIQUE,
  direction          message_direction NOT NULL,
  kind               TEXT,
  template           TEXT,
  in_window          BOOLEAN,
  cost_estimate_kobo BIGINT,
  status             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_by_user ON messages (user_id, created_at DESC);

-- Section 11: message text lives here and nowhere else, and only for 30 days.
CREATE TABLE parser_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users (id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages (id) ON DELETE CASCADE,
  text       TEXT,
  intent     TEXT,
  confidence REAL,
  latency_ms INTEGER,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX parser_logs_purge ON parser_logs (created_at) WHERE text IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  event_type      TEXT,
  payload_json    JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  error           TEXT,
  -- Section 7: unique per provider. Processing is idempotent because of this.
  UNIQUE (provider, event_id)
);

CREATE INDEX webhook_events_unprocessed
  ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE referrals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',
  credited_at TIMESTAMPTZ,
  UNIQUE (referred_id),
  -- Self-referral is rejected (F25).
  CONSTRAINT referrals_not_self CHECK (referrer_id <> referred_id)
);

CREATE TABLE risk_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users (id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  resolved_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX risk_flags_open ON risk_flags (created_at) WHERE status = 'open';

-- Append-only. Nothing here is ever updated or deleted.
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before_json JSONB,
  after_json  JSONB,
  request_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_by_target ON audit_log (target_type, target_id, created_at DESC);

CREATE TABLE admin_users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL UNIQUE,
  role                TEXT NOT NULL DEFAULT 'support',
  totp_secret_encrypted BYTEA,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Section 14: anything that may change without a deploy.
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
