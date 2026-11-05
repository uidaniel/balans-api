-- The first-document nudge (5 November 2026): half of those who finish setup
-- never send anything. One message a few hours after setup, inside the
-- WhatsApp window, with the way in and an example. Sent once.
ALTER TABLE users ADD COLUMN first_doc_nudge_at TIMESTAMPTZ;
