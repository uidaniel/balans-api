-- When the sender was told their client opened the document (31 October
-- 2026). See documents/opened.ts.
--
-- Its own column rather than `viewed_at`: that one is set by the first open
-- of any kind, and the first open is often a link preview or the sender
-- checking their own link. This is set by the open they were told about,
-- once, so a document is announced at most once however often it is opened.
ALTER TABLE documents ADD COLUMN opened_told_at TIMESTAMPTZ;
