/**
 * Where invoice numbering starts.
 *
 * The number is printed on the document and on the payment page, and the
 * message carrying an invoice is built to be forwarded untouched — so
 * "INVOICE #3" told the client this was the third invoice its sender had ever
 * issued. Hiding it is the wrong fix; letting it start where the user says is
 * the one every invoicing tool has.
 *
 * The property that matters is one-way: raising the start skips forward,
 * lowering it does nothing. Numbers must never repeat or go backwards, and
 * `documents_number_per_user_type` would reject it if they tried.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { createDraft, confirmDraft } = await import("./store.ts");

describe("invoice numbering", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;

  before(async () => {
    await db().query(`DELETE FROM users WHERE wa_phone LIKE '234903%' AND business_name = 'Number Co'`);
    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Number Co') RETURNING id`,
      [`234903${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  const base = {
    type: "invoice" as const,
    clientName: "A Client",
    clientEmail: null,
    dueDate: null,
    vatPercent: null,
    depositPercent: null,
    instalments: null,
    passFeesToClient: false,
    notes: null,
    lines: [{ description: "work", qty: 1, unitAmountKobo: 100_000 }],
  };

  /** Draft one and send it, returning the number it was given. */
  const issue = async (): Promise<number> => {
    const draft = await createDraft(userId, base);
    const done = await confirmDraft(userId, draft.id);
    assert.ok(done, "the draft should confirm");
    return done.number;
  };

  const setStart = (n: number) =>
    db().query(`UPDATE users SET invoice_number_start = $2 WHERE id = $1`, [userId, n]);

  it("starts at 1 by default", async () => {
    assert.equal(await issue(), 1);
    assert.equal(await issue(), 2);
  });

  it("skips forward when the start is raised", async () => {
    // The whole point: somebody moving from another tool carries on from
    // where they were rather than restarting at 1.
    await setStart(1047);
    assert.equal(await issue(), 1047);
    assert.equal(await issue(), 1048, "and carries on from there");
  });

  it("does nothing when the start is lowered", async () => {
    // Numbers cannot go backwards. A start below what has been issued is
    // simply ignored, rather than colliding with an invoice already sent.
    await setStart(5);
    assert.equal(await issue(), 1049);
  });

  it("refuses a start outside what the column allows", async () => {
    await assert.rejects(() => setStart(0), /invoice_number_start/);
    await assert.rejects(() => setStart(-1), /invoice_number_start/);
  });

  it("keeps a number once it has been given", async () => {
    // documents_number_is_final: a number is assigned on send and never
    // rewritten, so a later change of start cannot renumber what was sent.
    const n = await issue();
    await setStart(9000);
    const { rows } = await db().query<{ number: number }>(
      `SELECT number FROM documents WHERE user_id = $1 AND number = $2`,
      [userId, n],
    );
    assert.equal(rows[0]?.number, n, "an issued number must not move");
  });
});
