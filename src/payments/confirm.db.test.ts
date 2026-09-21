/**
 * Payment confirmation, against a real database.
 *
 * The rules being checked here cannot be checked without one. Idempotency
 * lives in a `status <> 'success'` guard and a `FOR UPDATE`; the overpayment
 * cap lives in a CHECK constraint. A mock would agree with whatever I wrote,
 * which is the opposite of the point.
 *
 * Skipped when DATABASE_URL is absent, so `npm test` stays offline. Run it
 * with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { confirmPayment } = await import("./confirm.ts");
const { recordInitialisedPayment } = await import("../documents/payments.ts");
import type { VerifyResult } from "./monnify.ts";

/** A logger that satisfies the signature and says nothing. */
const quiet = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return quiet; },
  level: "silent",
} as any;

/** Monnify, replaced by a fixed answer. */
const saying = (over: Record<string, unknown>) =>
  async (): Promise<VerifyResult> => ({
    ok: true,
    raw: {},
    transaction: {
      transactionReference: "MNFY|test",
      paymentReference: "",
      paymentStatus: "PAID",
      amountPaidKobo: 0,
      totalPayableKobo: 0,
      settlementAmountKobo: null,
      currency: "NGN",
      paymentMethod: "CARD",
      paidOn: null,
      ...over,
    } as VerifyResult extends { ok: true; transaction: infer T } ? T : never,
  });

describe("confirming a payment", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;
  let clientId: string;

  before(async () => {
    // Sweep anything a previous run left behind. A crashed test should not
    // leave rows that show up next to real ones in a development database.
    await db().query(
      `DELETE FROM payments WHERE document_id IN (
         SELECT d.id FROM documents d JOIN users u ON u.id = d.user_id
          WHERE u.wa_phone LIKE '234900%' AND u.business_name = 'Test Co')`,
    );
    await db().query(`DELETE FROM users WHERE wa_phone LIKE '234900%' AND business_name = 'Test Co'`);

    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Test Co') RETURNING id`,
      [`234900${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;
    const c = await db().query<{ id: string }>(
      `INSERT INTO clients (user_id, name) VALUES ($1, 'Test Client') RETURNING id`,
      [userId],
    );
    clientId = c.rows[0]!.id;
  });

  after(async () => {
    // Payments do not cascade from documents, by design: deleting a user must
    // never quietly erase the record of money that moved. Production soft
    // deletes with `users.deleted_at` and this never comes up; a test that
    // makes its own rows has to take them back down in order.
    await db().query(
      `DELETE FROM payments WHERE document_id IN (SELECT id FROM documents WHERE user_id = $1)`,
      [userId],
    );
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  /** A sent invoice with a payment waiting on it. */
  async function scenario(totalKobo: number, alreadyPaidKobo = 0) {
    const d = await db().query<{ id: string }>(
      `INSERT INTO documents
         (user_id, client_id, type, number, status, subtotal_kobo, total_kobo,
          amount_paid_kobo, public_token)
       VALUES ($1, $2, 'invoice',
               (SELECT COALESCE(MAX(number),0)+1 FROM documents WHERE user_id=$1 AND type='invoice'),
               $3, $4, $4, $5, $6)
       RETURNING id`,
      [userId, clientId, alreadyPaidKobo > 0 ? "part_paid" : "sent", totalKobo, alreadyPaidKobo,
       randomUUID().replace(/-/g, "")],
    );
    const documentId = d.rows[0]!.id;
    const reference = `bal_test_${randomUUID().slice(0, 12)}`;

    await recordInitialisedPayment({
      documentId, userId, reference,
      providerReference: "MNFY|test",
      amountKobo: totalKobo - alreadyPaidKobo,
      balansFeeKobo: 500_00,
      expectedProcessorFeeKobo: 850_00,
    });

    return { documentId, reference };
  }

  const docRow = async (id: string) => {
    const { rows } = await db().query<{ status: string; amount_paid_kobo: number; paid_at: Date | null }>(
      `SELECT status, amount_paid_kobo, paid_at FROM documents WHERE id = $1`, [id]);
    return rows[0]!;
  };

  const payRow = async (reference: string) => {
    const { rows } = await db().query<{ status: string; channel: string | null }>(
      `SELECT status, channel FROM payments WHERE reference = $1`, [reference]);
    return rows[0]!;
  };

  it("marks a matching payment paid", async () => {
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, amountPaidKobo: 50_000_00, totalPayableKobo: 50_000_00 }),
    );

    assert.equal(out.kind, "confirmed");
    const doc = await docRow(documentId);
    assert.equal(doc.status, "paid");
    assert.equal(doc.amount_paid_kobo, 50_000_00);
    assert.ok(doc.paid_at, "paid_at must be stamped");
    assert.equal((await payRow(reference)).status, "success");
  });

  it("changes nothing on a second delivery", async () => {
    // Monnify retries. The same payment arriving twice must not credit twice.
    const { documentId, reference } = await scenario(50_000_00);
    const verify = saying({ paymentReference: reference, amountPaidKobo: 50_000_00, totalPayableKobo: 50_000_00 });

    const first = await confirmPayment({ paymentReference: reference, transactionReference: "MNFY|test" }, quiet, verify);
    const second = await confirmPayment({ paymentReference: reference, transactionReference: "MNFY|test" }, quiet, verify);

    assert.equal(first.kind, "confirmed");
    assert.equal(second.kind, "already_confirmed");
    assert.equal((await docRow(documentId)).amount_paid_kobo, 50_000_00, "credited twice");
  });

  it("changes nothing when both deliveries arrive at once", async () => {
    // The optimistic check cannot catch this; the UPDATE guard has to.
    const { documentId, reference } = await scenario(50_000_00);
    const verify = saying({ paymentReference: reference, amountPaidKobo: 50_000_00, totalPayableKobo: 50_000_00 });

    const [a, b] = await Promise.all([
      confirmPayment({ paymentReference: reference, transactionReference: "MNFY|test" }, quiet, verify),
      confirmPayment({ paymentReference: reference, transactionReference: "MNFY|test" }, quiet, verify),
    ]);

    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ["already_confirmed", "confirmed"], `got ${kinds.join(" + ")}`);
    assert.equal((await docRow(documentId)).amount_paid_kobo, 50_000_00, "credited twice under a race");
  });

  it("holds a short payment for review rather than marking it paid", async () => {
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, amountPaidKobo: 40_000_00, totalPayableKobo: 50_000_00 }),
    );

    assert.equal(out.kind, "needs_review");
    assert.equal((await docRow(documentId)).status, "sent", "a short payment must not settle it");
    assert.equal((await payRow(reference)).status, "needs_review");
  });

  it("holds a payment in the wrong currency", async () => {
    const { reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, amountPaidKobo: 50_000_00, currency: "USD" }),
    );
    assert.equal(out.kind, "needs_review");
  });

  it("holds a payment whose reference does not come back the same", async () => {
    // This is the one that would credit the wrong person's invoice.
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: "bal_somebody_else", amountPaidKobo: 50_000_00 }),
    );

    assert.equal(out.kind, "needs_review");
    assert.equal((await docRow(documentId)).status, "sent");
  });

  it("takes an overpayment without breaking the books", async () => {
    // `documents_paid_within_total` will not hold more than the total, so the
    // document caps and the payment row keeps what really arrived.
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, paymentStatus: "OVERPAID", amountPaidKobo: 60_000_00 }),
    );

    assert.equal(out.kind, "confirmed");
    const doc = await docRow(documentId);
    assert.equal(doc.status, "paid");
    assert.equal(doc.amount_paid_kobo, 50_000_00, "the document must not exceed its total");
  });

  it("adds a part payment to what was already paid", async () => {
    const { documentId, reference } = await scenario(50_000_00, 20_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, amountPaidKobo: 30_000_00, totalPayableKobo: 30_000_00 }),
    );

    assert.equal(out.kind, "confirmed");
    const doc = await docRow(documentId);
    assert.equal(doc.amount_paid_kobo, 50_000_00);
    assert.equal(doc.status, "paid");
  });

  it("records an abandoned checkout without touching the invoice", async () => {
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, paymentStatus: "ABANDONED", amountPaidKobo: 0 }),
    );

    assert.equal(out.kind, "not_paid");
    assert.equal((await docRow(documentId)).status, "sent");
    assert.equal((await payRow(reference)).status, "failed");
  });

  it("leaves a pending checkout alone", async () => {
    // The client may be on the payment page right now. Writing it off as
    // failed puts a wrong word next to a payment still likely to arrive.
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, paymentStatus: "PENDING", amountPaidKobo: 0 }),
    );

    assert.equal(out.kind, "not_paid");
    assert.equal((await docRow(documentId)).status, "sent");
    assert.equal((await payRow(reference)).status, "initialised", "pending is not failed");
  });

  it("holds a part payment that arrived short", async () => {
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      saying({ paymentReference: reference, paymentStatus: "PARTIALLY_PAID", amountPaidKobo: 30_000_00 }),
    );

    assert.equal(out.kind, "needs_review");
    assert.equal((await docRow(documentId)).status, "sent");
    assert.equal((await payRow(reference)).status, "needs_review");
  });

  it("ignores a reference it never issued", async () => {
    const out = await confirmPayment(
      { paymentReference: "bal_never_existed", transactionReference: "MNFY|test" },
      quiet,
      saying({}),
    );
    assert.equal(out.kind, "unknown_reference");
  });

  it("asks for a retry when Monnify cannot be reached", async () => {
    const { documentId, reference } = await scenario(50_000_00);
    const out = await confirmPayment(
      { paymentReference: reference, transactionReference: "MNFY|test" },
      quiet,
      async () => ({ ok: false, message: "timeout" }),
    );

    assert.equal(out.kind, "unverifiable");
    assert.equal((await docRow(documentId)).status, "sent", "nothing may change on an unknown outcome");
    assert.equal((await payRow(reference)).status, "initialised");
  });
});
