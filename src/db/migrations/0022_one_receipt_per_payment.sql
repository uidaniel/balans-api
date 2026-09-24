-- One receipt, and one receipt number, per payment.
--
-- `renderReceiptPdf` has always ended with `ON CONFLICT DO NOTHING`, written
-- as the guard against writing a second receipt for a payment. There was no
-- unique constraint for it to conflict with, so it has never done anything.
--
-- It matters because the render is not called once. `notifyPaid` renders the
-- attachment, and there are two paths to a confirmation -- the webhook and
-- the invoice page's poll -- plus a re-send by hand when both were missed.
-- Each extra call took the next number off the user's receipt sequence and
-- wrote another row against the same payment, every one of them pointing at
-- the single `pdf_key` that the newest render had just overwritten. The
-- stored file therefore disagreed with every row but the last, and the
-- freelancer's receipt numbers had gaps nobody could account for.
--
-- Found on 24 Sep 2026 on the recovered $150 card payment, which ended up
-- with receipts 1, 2 and 3 after the notification was sent by hand twice.

-- The duplicates first, or the index cannot be built. The earliest row wins:
-- it is the one whose number was handed out at the time the payment was
-- actually confirmed, and the later ones are re-renders of the same money.
DELETE FROM receipts r
 USING receipts keep
 WHERE r.payment_id = keep.payment_id
   AND keep.number < r.number;

-- Deliberately a constraint rather than an index, so the `ON CONFLICT
-- (payment_id)` in the insert has something named to target.
ALTER TABLE receipts
  ADD CONSTRAINT receipts_payment_id_key UNIQUE (payment_id);
