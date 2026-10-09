-- Changing an invoice after it was sent (9 October 2026).
--
-- The invoice keeps its number, its link and its id; its content is replaced
-- and `current_version` goes up, so the next PDF is rendered fresh and the
-- old one stays in `document_versions`. Each change is kept here too, because
-- a change counts as a document made towards the Free plan's monthly limit:
-- sending an invoice and then changing it is two documents' worth of work.

CREATE TABLE document_edits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_edits_by_user_month ON document_edits (user_id, created_at);

ALTER TABLE document_edits ENABLE ROW LEVEL SECURITY;
