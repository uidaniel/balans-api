/**
 * The cache, and the refusal.
 *
 * Section 6's rules read like caching policy and are not. They are the answer
 * to one question: when is a number no longer good enough to price somebody's
 * month of work at? An hour old is fine, because the feed publishes daily. A
 * day old is not, because by then the number has stopped being evidence about
 * today — and there is no fallback, no last-known-good stretched to a week,
 * no hard-coded 1,300 for when the provider is down. The draft simply does
 * not happen.
 *
 * All of it is `now() - fetched_at` against rows in a table, which is to say
 * none of it can be proved without one. The unit tests next door prove that a
 * bad *response* is refused; only this can prove that a stale *row* is.
 *
 * Skipped when DATABASE_URL is absent. Run it with `npm run test:db`.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { db, closeDb } = await import("../db/pool.ts");
const { current, pairFor } = await import("./rate.ts");

/** A pair nothing real uses, so this test cannot disturb a live rate. */
const PAIR = pairFor("GBP");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A provider that answers with this rate, and counts how often it is asked. */
function feed(rate: number) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return new Response(JSON.stringify({ result: "success", rates: { NGN: rate } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A provider that is down. */
const down = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

async function seed(rate: number, agoMs: number, source = "seeded"): Promise<void> {
  await db().query(
    `INSERT INTO fx_rates (pair, rate, source, fetched_at)
     VALUES ($1, $2, $3, now() - ($4 || ' milliseconds')::interval)`,
    [PAIR, rate, source, String(agoMs)],
  );
}

const clear = () => db().query(`DELETE FROM fx_rates WHERE pair = $1`, [PAIR]);

describe("the rate cache", { skip: !HAS_DB && "no DATABASE_URL" }, () => {
  before(() => {
    // "fixed" would never touch the network and "open-er-api" would touch the
    // real one; the tests hand in their own fetch either way, so the provider
    // only has to be one that exists.
    process.env.FX_PROVIDER = "open-er-api";
    process.env.FX_CACHE_MINUTES = "60";
    process.env.FX_STALE_MAX_HOURS = "24";
  });

  beforeEach(clear);

  after(async () => {
    await clear();
    await closeDb();
  });

  it("fetches when it holds nothing, and keeps what it got", async () => {
    const { fetchImpl, calls } = feed(1791.751317);
    const quote = await current("GBP", { fetchImpl });

    assert.equal(calls.n, 1);
    assert.equal(quote?.rate, 1791.751317);
    assert.equal(quote?.source, "open.er-api.com");
    assert.equal(quote?.pair, "GBPNGN");

    // Written down, because an invoice priced at this has to be able to point
    // at the row afterwards.
    const { rows } = await db().query<{ rate: string; source: string; raw_json: unknown }>(
      `SELECT rate, source, raw_json FROM fx_rates WHERE pair = $1`,
      [PAIR],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.rate), 1791.751317);
    assert.ok(rows[0]!.raw_json, "the provider's answer was not kept");
  });

  it("does not ask again within the hour", async () => {
    await seed(1800, 10 * MINUTE);
    const { fetchImpl, calls } = feed(9999);

    const quote = await current("GBP", { fetchImpl });
    assert.equal(calls.n, 0, "the provider was asked despite a fresh rate");
    assert.equal(quote?.rate, 1800);
  });

  it("asks again once the hour is up", async () => {
    await seed(1800, 90 * MINUTE);
    const { fetchImpl, calls } = feed(1850);

    const quote = await current("GBP", { fetchImpl });
    assert.equal(calls.n, 1);
    assert.equal(quote?.rate, 1850);
  });

  it("keeps working on a rate from this morning when the provider is down", async () => {
    /*
     * Nine hours old, from a feed that publishes once a day: the same number
     * it would return if it were up. Refusing to let somebody invoice here
     * would be refusing for no gain in accuracy at all.
     */
    await seed(1800, 9 * HOUR);
    const quote = await current("GBP", { fetchImpl: down });
    assert.equal(quote?.rate, 1800);
    assert.equal(quote?.source, "seeded", "a served rate must still name where it came from");
  });

  it("refuses once the newest thing it holds is over a day old", async () => {
    // The whole point. Null here is what stops a $5,000 invoice going out
    // priced at a rate from before the naira moved.
    await seed(1800, 25 * HOUR);
    assert.equal(await current("GBP", { fetchImpl: down }), null);
  });

  it("refuses when it holds nothing at all and cannot fetch", async () => {
    assert.equal(await current("GBP", { fetchImpl: down }), null);
  });

  it("refuses rather than serve a stored rate that cannot be one", async () => {
    /*
     * A row written by an earlier version of this code, or by hand. Being in
     * our own table is not the same as being trustworthy, and 0.00075 is the
     * pair quoted the other way round — which would price $500 of work at
     * about forty kobo.
     */
    await seed(0.00075, 5 * MINUTE);
    assert.equal(await current("GBP", { fetchImpl: down }), null);
  });

  it("falls back to what it holds when the provider answers with rubbish", async () => {
    await seed(1800, 3 * HOUR);
    const rubbish = (async () =>
      new Response(JSON.stringify({ result: "success", rates: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    assert.equal((await current("GBP", { fetchImpl: rubbish }))?.rate, 1800);
  });

  it("keeps every rate it has used, rather than overwriting one row", async () => {
    /*
     * History, not a current value. When somebody asks in March why their
     * January invoice converted at 1,327, the answer has to be a row.
     */
    await seed(1800, 3 * HOUR);
    const { fetchImpl } = feed(1850);
    await current("GBP", { fetchImpl });

    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*) AS n FROM fx_rates WHERE pair = $1`,
      [PAIR],
    );
    assert.equal(Number(rows[0]!.n), 2);
  });
});
