/**
 * A draft's payment plan reaches the database (PRD F7).
 *
 * This is the test that would have caught the bug it was written for.
 *
 * `depositPercent` was parsed, shown on the draft as "Deposit — 50% up front",
 * confirmed by the user, and then dropped: `createParts` had no caller, so the
 * document went out with no parts and the payment page asked the client for
 * the whole amount. Every unit test passed the whole time, because every piece
 * worked — nothing joined them up.
 *
 * So the assertions here are deliberately about rows rather than return
 * values. A stub would have agreed with the old code too.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { createDraft, getOpenDraft } = await import("./store.ts");

const N = (naira: number) => naira * 100;

describe("saving a draft with a payment plan", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;

  before(async () => {
    await db().query(`DELETE FROM users WHERE wa_phone LIKE '234901%' AND business_name = 'Parts Co'`);
    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Parts Co') RETURNING id`,
      [`234901${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  const base = {
    type: "invoice" as const,
    clientName: "Daniel",
    clientEmail: null,
    dueDate: null,
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    lines: [{ description: "website design", qty: 1, unitAmountKobo: N(250_000) }],
  };

  /** The rows as the payment page will find them. */
  const partsOf = async (documentId: string) =>
    (
      await db().query<{ position: number; label: string; amount_kobo: string; status: string }>(
        `SELECT position, label, amount_kobo, status FROM payment_parts
          WHERE document_id = $1 ORDER BY position`,
        [documentId],
      )
    ).rows.map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo) }));

  it("writes a deposit as two parts, only the first payable", async () => {
    const draft = await createDraft(userId, { ...base, depositPercent: 50 });
    const parts = await partsOf(draft.id);

    assert.equal(parts.length, 2, "a deposit is two payments, not one");
    assert.deepEqual(
      parts.map((p) => [p.label, p.amount_kobo, p.status]),
      [
        ["50% deposit", N(125_000), "payable"],
        ["Balance", N(125_000), "pending"],
      ],
    );
  });

  it("writes instalments, and they add up to the total exactly", async () => {
    // 250,000 over 3 does not divide. The remainder has to land somewhere, and
    // a client who pays every part must have paid the invoice.
    const draft = await createDraft(userId, { ...base, instalments: 3 });
    const parts = await partsOf(draft.id);

    assert.equal(parts.length, 3);
    assert.equal(
      parts.reduce((sum, p) => sum + p.amount_kobo, 0),
      N(250_000),
      "the parts must sum to the total, to the kobo",
    );
    assert.deepEqual(parts.map((p) => p.status), ["payable", "pending", "pending"]);
  });

  it("writes nothing when the invoice is paid in one go", async () => {
    const draft = await createDraft(userId, base);
    assert.deepEqual(await partsOf(draft.id), []);
  });

  it("replaces the plan when the draft is replaced", async () => {
    // A correction rebuilds the draft. The old parts must not survive it, or a
    // draft corrected from 3 payments to 2 would go out asking for five.
    await createDraft(userId, { ...base, instalments: 3 });
    const after = await createDraft(userId, { ...base, depositPercent: 25 });

    const parts = await partsOf(after.id);
    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.label, "25% deposit");
  });

  it("reads the plan back off the draft", async () => {
    // What the summary re-renders from. Recovered from the parts rather than
    // stored twice, so the two cannot disagree.
    await createDraft(userId, { ...base, depositPercent: 40 });
    assert.equal((await getOpenDraft(userId))?.depositPercent, 40);

    await createDraft(userId, { ...base, instalments: 4 });
    const back = await getOpenDraft(userId);
    assert.equal(back?.instalments, 4);
    assert.equal(back?.depositPercent, null);
  });
});
