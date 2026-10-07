-- A third way a client abroad can pay (7 October 2026): into the sender's
-- own Nigerian bank account, as a naira invoice is paid, with the naira
-- figure the invoice converts to. Beside a Balans card link and the sender's
-- own details (migration 0034).

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_pay_by_check;
ALTER TABLE documents ADD CONSTRAINT documents_pay_by_check CHECK (pay_by IN ('link', 'own', 'bank'));
