/**
 * What counts as a document this user has sent.
 *
 * The number decides when the "pick a design" offer stops, and every offer
 * after the first is a chargeable message. So the exclusions are the point:
 * a draft never reached anybody, a cancelled document was taken back, and a
 * sample is ours rather than theirs. Counting any of them would silence the
 * offer before the user had seen a real invoice.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { documentsEverSent } = await import("./queries.ts");

describe("counting what a user has sent", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;
  let clientId: string;
  let n = 0;

  before(async () => {
    await db().query(`DELETE FROM users WHERE wa_phone LIKE '234902%' AND business_name = 'Count Co'`);
    const u = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Count Co') RETURNING id`,
      [`234902${Date.now().toString().slice(-7)}`],
    );
    userId = u.rows[0]!.id;
    const c = await db().query<{ id: string }>(
      `INSERT INTO clients (user_id, name) VALUES ($1, 'A Client') RETURNING id`,
      [userId],
    );
    clientId = c.rows[0]!.id;
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  /** One document in whatever state, with a number nobody else is using. */
  const make = async (status: string, type = "invoice") => {
    n += 1;
    await db().query(
      `INSERT INTO documents (user_id, client_id, type, number, status, total_kobo)
       VALUES ($1, $2, $3::document_type, $4, $5::document_status, 100000)`,
      [userId, clientId, type, n, status],
    );
  };

  it("starts at nothing", async () => {
    assert.equal(await documentsEverSent(userId), 0);
  });

  it("counts a sent invoice", async () => {
    await make("sent");
    assert.equal(await documentsEverSent(userId), 1);
  });

  it("counts one that has been viewed or paid", async () => {
    await make("viewed");
    await make("paid");
    assert.equal(await documentsEverSent(userId), 3);
  });

  it("does not count a draft", async () => {
    // A draft is a message on a screen, not an invoice anybody received.
    await make("draft");
    assert.equal(await documentsEverSent(userId), 3);
  });

  it("does not count one that was cancelled", async () => {
    await make("cancelled");
    assert.equal(await documentsEverSent(userId), 3);
  });

  it("counts quotes, which are sent to clients too", async () => {
    await make("sent", "quote");
    assert.equal(await documentsEverSent(userId), 4);
  });

  it("counts nothing for a user with no documents", async () => {
    const other = await db().query<{ id: string }>(
      `INSERT INTO users (wa_phone, business_name) VALUES ($1, 'Count Co') RETURNING id`,
      [`234902${(Date.now() + 1).toString().slice(-7)}`],
    );
    const id = other.rows[0]!.id;
    assert.equal(await documentsEverSent(id), 0, "it must not count another user's documents");
    await db().query(`DELETE FROM users WHERE id = $1`, [id]);
  });
});
