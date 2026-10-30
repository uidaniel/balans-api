-- When somebody who stopped part-way through setup was nudged (30 October 2026).
--
-- `setup_nudge_at`: the one message in the chat a few hours after they went
-- quiet, while WhatsApp still lets us write freely. The form again, or the
-- question they stopped on.
--
-- `setup_followup_at`: the one follow-up two days later, by email and by the
-- `setup_reminder` template. Both are set before anything is sent, so each
-- goes once, whatever happens to the send.
ALTER TABLE users ADD COLUMN setup_nudge_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN setup_followup_at TIMESTAMPTZ;
