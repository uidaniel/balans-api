/**
 * Runs the background jobs once, by hand.
 *
 * For checking what a tick would do without waiting an hour for one, and for
 * a host that would rather drive these from cron than from the API process.
 */

import { runDailyJobs } from "./overdue.ts";
import { closeDb } from "../db/pool.ts";

const log = {
  info: (o: unknown, m?: string) => console.log("info ", m ?? "", JSON.stringify(o)),
  warn: (o: unknown, m?: string) => console.log("warn ", m ?? "", JSON.stringify(o)),
  error: (o: unknown, m?: string) => console.log("error", m ?? "", JSON.stringify(o)),
  debug: () => {},
  trace: () => {},
  fatal: (o: unknown, m?: string) => console.log("fatal", m ?? "", JSON.stringify(o)),
  child() { return log; },
  level: "info",
} as never;

await runDailyJobs(log);
await closeDb();
console.log("done");
