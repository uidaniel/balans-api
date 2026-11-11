/**
 * Every table a migration makes has row level security turned on
 * (11 November 2026). identity_checks went out without it on 2 November and
 * sat open to the public key for nine days; this stops the next one at test.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const dir = new URL("./migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const all = files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");

describe("row level security", () => {
  it("is turned on for every table made since the sweep of 27 September (0026)", () => {
    const missing: string[] = [];
    for (const f of files.filter((f) => f >= "0026")) {
      const sql = readFileSync(new URL(f, dir), "utf8");
      for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)) {
        const t = m[1]!.toLowerCase();
        if (!new RegExp(`alter table\\s+${t}\\s+enable row level security`, "i").test(all)) missing.push(`${t} (${f})`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
