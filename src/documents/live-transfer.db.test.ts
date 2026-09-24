/**
 * Finding the account a client is already part-way through paying into.
 *
 * `liveTransferFor` is asked for a stage of a document — what the plan calls
 * the deposit or the balance — and it matched on what the client was charged
 * for that stage instead. Those are the same number until fees are passed to
 * the client, and then the charge is the stage grossed up by the processor's
 * cut, so on every fee-passing invoice the lookup found nothing.
 *
 * Which broke two things at once:
 *
 *   - the Pay button's guard against minting a second account for the same
 *     balance, which is the one thing its comment says must not happen —
 *     Monnify matches a transfer on the account *and* the amount, so two live
 *     accounts for one balance is a way to lose somebody's money;
 *   - and, once the button stopped rendering the panel itself, the page could
 *     not find the account it had just created. Pressing Pay reloaded the
 *     invoice with nothing on it.
 *
 * The second hid the first for as long as the panel came back in the body of
 * the POST. A database is the only thing that can catch either.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { recordInitialisedPayment, recordTransferAccount, liveTransferFor } =
  await import("./payments.ts");

/** The invoice in the report: ₦215,000, a 25% deposit, fees passed on. */
const STAGE = 161_250_00;
const CHARGED = 163_250_00;

describe("the account already waiting on an invoice", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;
  let documentId: string;

  before(async () => {
    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Live Co') RETURNING id`,
      [`234901${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;

    const c = await db().query<{ id: string }>(
      `INSERT INTO clients (user_id, name) VALUES ($1, 'Live Client') RETURNING id`,
      [userId],
    );

    const d = await db().query<{ id: string }>(
      `INSERT INTO documents
         (user_id, client_id, type, number, status, subtotal_kobo, total_kobo,
          amount_paid_kobo, pass_fees_to_client, public_token)
       VALUES ($1, $2, 'invoice', 1, 'part_paid', 215000_00, 215000_00, 53750_00, TRUE, $3)
       RETURNING id`,
      [userId, c.rows[0]!.id, randomUUID().replace(/-/g, "")],
    );
    documentId = d.rows[0]!.id;
  });

  after(async () => {
    await db().query(`DELETE FROM payments WHERE document_id = $1`, [documentId]);
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  /** A Pay press: an initialised payment with an account issued against it. */
  async function press(expiresAt: Date): Promise<string> {
    const reference = `bal_live_${randomUUID().slice(0, 12)}`;
    await recordInitialisedPayment({
      documentId,
      userId,
      reference,
      providerReference: "MNFY|live",
      // What the client is charged, which is the stage grossed up.
      amountKobo: CHARGED,
      invoiceAmountKobo: STAGE,
      balansFeeKobo: 453_30,
      expectedProcessorFeeKobo: 2_000_00,
    });
    await recordTransferAccount(reference, {
      bankName: "Sterling bank",
      bankCode: "232",
      accountNumber: "7000299462",
      accountName: "Balans-Inv",
      ussd: null,
      expiresAt,
    });
    return reference;
  }

  it("is found by what the stage is worth, not by what was charged for it", async () => {
    /*
     * The page asks for the balance — ₦161,250, the figure on the invoice and
     * in the plan. It has no reason to know the surcharge, which is worked
     * out when the payment is created and belongs to the payment.
     */
    const reference = await press(new Date(Date.now() + 40 * 60_000));

    const found = await liveTransferFor(documentId, STAGE);
    assert.ok(found, "the page could not find the account it had just created");
    assert.equal(found.reference, reference);
    assert.equal(found.accountNumber, "7000299462");

    // And it reports what the client actually has to send, which is the
    // grossed-up figure — the panel says "send exactly" about this one.
    assert.equal(found.amountKobo, CHARGED);
  });

  it("does not answer to the charged figure, which is nobody's question", async () => {
    // Asking with the surcharge included would mean some caller had done the
    // gross-up itself, which is how the two figures got confused in the first
    // place.
    assert.equal(await liveTransferFor(documentId, CHARGED), null);
  });

  it("is not offered once it is nearly out of time", async () => {
    // Monnify frees the account at its expiry. Handing somebody a number with
    // seconds left on it is worse than making a new one.
    await db().query(`DELETE FROM payments WHERE document_id = $1`, [documentId]);
    await press(new Date(Date.now() + 20_000));
    assert.equal(await liveTransferFor(documentId, STAGE), null);
  });
});
