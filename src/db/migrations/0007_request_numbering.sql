-- Payment requests share the invoice number sequence (PRD F8).
--
-- The existing unique index is on (user_id, type, number), which would happily
-- allow Invoice 4 and Request 4 for the same user. A client receiving both
-- would reasonably think one was a duplicate of the other, or worse, pay once.
--
-- The generator already draws from a shared sequence; this makes that a
-- guarantee rather than a convention, so a future code path cannot quietly
-- reintroduce the collision.

CREATE UNIQUE INDEX documents_billable_number_per_user
  ON documents (user_id, number)
  WHERE number IS NOT NULL AND type IN ('invoice', 'payment_request');
