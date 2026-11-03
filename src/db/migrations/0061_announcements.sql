-- Messages to every user, from the admin's Broadcast page (3 November 2026).
--
-- The same queue as the launch message (0029): the admin writes a broadcast
-- and its recipients, the API sends them. An announcement carries its own
-- words, and each recipient row names the user, so the send can tell who is
-- inside WhatsApp's 24-hour window and honour an opt-out made since.
ALTER TABLE broadcasts
  ADD COLUMN subject TEXT CHECK (char_length(subject) <= 120),
  ADD COLUMN message TEXT CHECK (char_length(message) <= 700);

ALTER TABLE broadcast_recipients
  ADD COLUMN user_id UUID REFERENCES users (id) ON DELETE CASCADE;

-- "STOP UPDATES" in the chat, or the link in the email. Announcements only:
-- invoices, receipts and reminders are the service and keep coming.
ALTER TABLE users ADD COLUMN updates_off_at TIMESTAMPTZ;
