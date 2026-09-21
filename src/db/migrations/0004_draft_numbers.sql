-- Draft documents have no number yet.
--
-- PRD F6 step 4: "On confirm, backend assigns the next invoice number." The
-- column was NOT NULL, which forced a number at draft time and left a gap in
-- the sequence every time a draft was abandoned — and F6 abandons them after
-- 24 hours. A client who receives invoice 7 and then invoice 11 reasonably
-- wonders what happened to three invoices.
--
-- Postgres allows any number of NULLs in a unique index, so
-- documents_number_per_user_type keeps working unchanged: it constrains the
-- numbers that exist and ignores the drafts that have none.

ALTER TABLE documents ALTER COLUMN number DROP NOT NULL;

-- A number, once assigned, is permanent. Nothing in the product renumbers a
-- document, and a trigger is cheaper than trusting every future caller.
CREATE OR REPLACE FUNCTION documents_number_is_final() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'document % already has number %, which cannot change',
      OLD.id, OLD.number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_number_is_final
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_number_is_final();

-- Finding a user's one open draft, and sweeping the ones nobody confirmed.
CREATE INDEX documents_open_drafts
  ON documents (user_id, created_at) WHERE status = 'draft';
