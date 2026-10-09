-- A title on a document (9 October 2026): "Website redesign — Phase 1",
-- "September retainer". Optional; shown on the PDF, the page, the email and
-- the summary when there is one, and nowhere when there is not.

ALTER TABLE documents ADD COLUMN title TEXT CHECK (char_length(title) <= 120);
