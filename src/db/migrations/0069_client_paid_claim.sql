-- "I've paid", from the client's invoice page (5 November 2026).
--
-- A naira invoice is paid by transfer straight to the sender, so Balans
-- cannot see it arrive, and senders forget to mark it: about one invoice in
-- four was marked paid. The client now taps "I've paid" after transferring,
-- and the sender is asked to check and confirm. Kept so the page shows it was
-- sent, and so the sender is told once, not every time the button is pressed.
ALTER TABLE documents ADD COLUMN client_paid_claim_at TIMESTAMPTZ;
