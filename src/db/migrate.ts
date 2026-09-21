/**
 * Migration runner.
 *
 * Plain .sql files applied in filename order, each inside its own transaction,
 * each recorded so it never runs twice. No framework: the schema is the thing
 * worth reading, and a dependency that hides it behind generated files is a bad
 * trade for a service whose whole job is being correct about money.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDb, db } from "./pool.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Records every pending migration as applied without running it.
 *
 * For a database whose schema was created by hand — pasted into a SQL editor
 * during setup, say. Without this the runner would try to apply 0001 again and
 * fail on the first `CREATE TYPE`, and the only alternatives are dropping a
 * live schema or editing the tracking table by hand.
 */
export async function baseline(log: (m: string) => void = console.log): Promise<number> {
  return migrate(log, { recordOnly: true });
}

export async function migrate(
  log: (m: string) => void = console.log,
  opts: { recordOnly?: boolean } = {},
): Promise<number> {
  const pool = db();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  let count = 0;
  for (const name of files) {
    const sql = await readFile(join(DIR, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    const seen = applied.get(name);

    if (seen) {
      // An edited migration means the database and the repo disagree about what
      // the schema is. Better to stop than to guess which one is right.
      if (seen !== checksum) {
        throw new Error(
          `Migration ${name} changed after it was applied (${seen} -> ${checksum}). ` +
            `Add a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!opts.recordOnly) await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
      await client.query("COMMIT");
      log(`${opts.recordOnly ? "recorded" : "applied"} ${name}`);
      count++;
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(e as Error).message}`, { cause: e });
    } finally {
      client.release();
    }
  }

  const verb = opts.recordOnly ? "recorded" : "applied";
  log(count ? `${count} migration(s) ${verb}` : "already up to date");
  return count;
}

// `npm run migrate`.
//
// `pathToFileURL` rather than string-building the URL: on Windows argv[1] is
// a backslash path and import.meta.url is a file:// URL, so comparing them
// directly never matches and the runner exits having done nothing, silently.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const recordOnly = process.argv.includes("--baseline");
    if (recordOnly) {
      console.log("baseline: recording existing migrations without running them");
    }
    await migrate(console.log, { recordOnly });
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
