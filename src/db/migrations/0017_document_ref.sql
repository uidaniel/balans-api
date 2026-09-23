-- One reference per document, unique across everybody.
--
-- `number` is the invoice number a client reads, and it restarts at 1 for
-- every freelancer, because that is what an invoice number means to the person
-- receiving it and to their accountant. Two people therefore both have an
-- invoice #1, which is correct on the document and useless for support: "my
-- invoice 2 has not been paid" names dozens of invoices.
--
-- So every document also gets a reference that belongs to nobody's sequence.
-- It is assigned when the document is sent, in the same transaction as the
-- number, and never changes afterwards.
--
-- A SEQUENCE rather than MAX(...) + 1. Two people sending at the same moment
-- read the same maximum and write the same reference, and the loser of that
-- race is somebody's invoice failing to send. A sequence hands out each value
-- once, to one caller, without taking a lock anybody else waits behind.
--
-- Gaps are fine and are the price of that: a sequence does not roll back, so a
-- send that fails after taking a number leaves a hole. A reference is an
-- identifier, not a count — nothing anywhere adds them up.
CREATE SEQUENCE IF NOT EXISTS document_ref_seq START 1;

-- Text, not an integer, because it is printed and read aloud down a phone.
-- "BL-0042" survives being written on paper and typed back in; 42 does not.
ALTER TABLE documents ADD COLUMN ref TEXT;

CREATE UNIQUE INDEX documents_ref_unique ON documents (ref);

-- Nullable, and left null on every row written before this. A reference
-- invented now would not be the one on the PDF a client already has.
