/**
 * Postgres connection pool.
 *
 * Money arrives as BIGINT, which node-postgres hands back as a string to avoid
 * silently losing precision past 2^53. Every amount in this system is integer
 * kobo and well inside a safe integer, so parsing to a number here keeps the
 * rest of the code working in numbers rather than strings — but it is a
 * deliberate choice, not an oversight, and it is why nothing stores money as a
 * float in the first place.
 */

import pg from "pg";
import { env, require_ } from "../config.ts";

const INT8 = 20;
pg.types.setTypeParser(INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT out of safe range: ${v}`);
  return n;
});

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (pool) return pool;
  require_("DATABASE_URL");
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Document numbering and payment application both depend on this: section 7
 * requires a number to be assigned inside a transaction.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
