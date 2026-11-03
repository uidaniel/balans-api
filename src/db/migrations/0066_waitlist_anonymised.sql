-- The waitlist, anonymised (3 November 2026).
--
-- The privacy notice kept waitlist details "until Balans opens and we have
-- told you". Balans opened in October and the launch message went out, so
-- the details go: the number, the email, what they bill for, and the scrambled
-- IP with the browser type. What stays carries nobody's identity and is what
-- the admin's counts are made of: when they joined, which page and link
-- brought them, the referral codes that link sign-ups to each other, whether
-- they were invited, and which account they became.
--
-- Agreed by the founders on 3 November 2026. It cannot be undone, which is the
-- point.
UPDATE waitlist
   SET email      = NULL,
       phone      = NULL,
       work       = NULL,
       ip_hash    = NULL,
       user_agent = NULL,
       token      = NULL
 WHERE created_at < now();
