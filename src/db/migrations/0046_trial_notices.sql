-- When somebody was last told about their trial or Pro (20 October 2026).
--
-- `trial_notice_at`: the one email sent two days after the last free document,
-- if they have gone quiet without paying. Set before it is sent, so it goes
-- once, whatever happens to the send.
--
-- `pro_nudged_at`: the last time a reply in the chat carried the one-line Pro
-- reminder, so it rides along at most once every few days.
ALTER TABLE users ADD COLUMN trial_notice_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN pro_nudged_at TIMESTAMPTZ;
