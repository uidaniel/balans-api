/**
 * The summary page, against a real database.
 *
 * Both bugs here reached production and both were invisible to every test we
 * had, for the same reason: the only thing that can say whether a query is
 * right is a database.
 *
 * The page answered 500 the first time anybody opened it — `column p.user_id
 * does not exist`. A payment belongs to a user through the document it paid;
 * the payments table has never had a user_id and the money-by-month chart
 * asked for one. The words on WhatsApp were correct the whole time, so
 * nothing looked broken until somebody tapped the button.
 *
 * And the link itself died on being replaced. A fresh token was minted on
 * every request, so running /summary and then /owed — the ordinary thing to
 * do — left the first message's button pointing at a token that had been
 * overwritten seconds before. It answered "Nothing here. This link has
 * expired", which was true and impossible for the person to make sense of.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { upsertUser } = await import("../conversation/store.ts");
const { summaryFor, issueSummaryToken, userForSummaryToken } = await import("./queries.ts");

const TODAY = { y: 2026, m: 9, d: 23 };

describe("the summary page", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  let userId: string;
  const phone = `234905${Date.now().toString().slice(-7)}`;

  before(async () => {
    userId = (await upsertUser(phone)).id;
    await db().query(`UPDATE users SET business_name = 'Test Studio' WHERE id = $1`, [userId]);
  });

  after(async () => {
    await db().query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  it("builds without asking for a column that does not exist", async () => {
    /*
     * The whole of the 500. Every query in here runs — the totals, the twelve
     * months of money in, the debtors and the best clients — and a new user
     * exercises all four without any of them having rows to work with, which
     * is the other case that has to work.
     */
    const data = await summaryFor(userId, TODAY);

    assert.ok(data, "a real user must produce a page");
    assert.equal(data.businessName, "Test Studio");
    assert.equal(data.invoicesSent, 0);
    assert.equal(data.paidKobo, 0);
    assert.equal(data.months.length, 12, "twelve months, including the empty ones");
    assert.deepEqual(
      data.months.map((m) => m.paidKobo),
      Array(12).fill(0),
    );
  });

  it("is nothing at all for a user who does not exist", async () => {
    assert.equal(await summaryFor("00000000-0000-0000-0000-000000000000", TODAY), null);
  });

  describe("the link to it", () => {
    it("hands out the same one while it is still alive", async () => {
      // /summary and then /owed. Two messages, two buttons, both of which
      // have to work — the first one is still sitting in the chat.
      const first = await issueSummaryToken(userId);
      const second = await issueSummaryToken(userId);

      assert.equal(second, first, "the second request killed the first message's button");
      assert.equal(await userForSummaryToken(first), userId);
      assert.equal(await userForSummaryToken(second), userId);
    });

    it("starts a fresh day each time it is handed out", async () => {
      // The link should die a day after it was last given to somebody, not a
      // day after the first time — otherwise a button can arrive with an hour
      // left on it.
      await issueSummaryToken(userId);
      await db().query(
        `UPDATE users SET summary_token_expires_at = now() + interval '2 hours' WHERE id = $1`,
        [userId],
      );

      await issueSummaryToken(userId);
      const { rows } = await db().query<{ hours: number }>(
        `SELECT EXTRACT(EPOCH FROM (summary_token_expires_at - now())) / 3600 AS hours
           FROM users WHERE id = $1`,
        [userId],
      );
      assert.ok(Number(rows[0]!.hours) > 23, `only ${rows[0]!.hours} hours left`);
    });

    it("mints a new one once the old has expired", async () => {
      const old = await issueSummaryToken(userId);
      await db().query(
        `UPDATE users SET summary_token_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [userId],
      );

      assert.equal(await userForSummaryToken(old), null, "a dead link must open nothing");
      assert.notEqual(await issueSummaryToken(userId), old, "a dead token was handed out again");
    });
  });
});
