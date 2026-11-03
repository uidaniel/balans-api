-- Where a sign-up came from (3 November 2026), for the admin panel.
--
-- Set once, from the first thing that tells us, and never overwritten: the
-- channel that brought somebody is the one that brought them.
--   ad        a Click-to-WhatsApp ad (Meta's referral on the first message)
--   post      a boosted Facebook or Instagram post (the same, from a post)
--   website   balans.ng's chat buttons ("Hi Balans", or "(ref: x)" from a ?ref link)
--   waitlist  the launch message's setup form, sent to the waitlist
--   direct    anything else: a saved number, a friend, a forwarded chat
-- Null for everybody who signed up before this was recorded.
ALTER TABLE users
  ADD COLUMN signup_source TEXT CHECK (signup_source IN ('ad', 'post', 'website', 'waitlist', 'direct')),
  -- The ad's headline, the website ref, or nothing.
  ADD COLUMN signup_detail TEXT CHECK (char_length(signup_detail) <= 200),
  -- Meta's id for the ad or post, to match against Ads Manager.
  ADD COLUMN signup_ad_id TEXT;
