-- F15: the summary that goes out on the 1st.
--
-- The daily job runs every hour, so "is it the 1st?" is true twelve times over
-- and would send twelve summaries. This is the record that one has already
-- gone, and the unique constraint is what makes a second attempt a no-op
-- rather than a second message somebody pays for.
--
-- Keyed on the month it covers, not the day it was sent: a job that misses the
-- 1st entirely and runs on the 2nd should still send September's summary once,
-- and still refuse to send it again on the 3rd.

CREATE TABLE monthly_summaries (
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The first day of the month being summarised.
  period_start DATE        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What it said, so a question about a figure can be answered later.
  paid_kobo    BIGINT      NOT NULL DEFAULT 0,
  documents    INTEGER     NOT NULL DEFAULT 0,

  PRIMARY KEY (user_id, period_start)
);
