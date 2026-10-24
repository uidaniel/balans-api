-- A Pro month runs from when it was paid, not from when it was asked for
-- (24 October 2026).
--
-- A month was dated when somebody asked for Pro and kept those dates however
-- late it was paid. One asked for before Pro ended on 7 October and paid on
-- 24 October ran to 7 November: two weeks for a month's money.
-- billing/subscription.ts now dates a month when its first money arrives.
-- This puts right the months already paid that way and still running.
--
-- Paid more than a day after the month's start means the Pro before it had
-- already ended when the money came, so the month starts at the payment. Its
-- length (a month or a year) is kept.

WITH fixed AS (
  UPDATE subscriptions s
     SET period_start = s.paid_at,
         period_end = s.paid_at + age(s.period_end, s.period_start)
   WHERE s.status = 'active'
     AND s.paid_at IS NOT NULL
     AND s.paid_at > s.period_start + interval '1 day'
     AND s.period_end > now()
  RETURNING s.user_id, s.period_end
)
UPDATE users u
   SET plan = 'pro',
       plan_expires_at = GREATEST(COALESCE(u.plan_expires_at, f.period_end), f.period_end)
  FROM fixed f
 WHERE u.id = f.user_id;
