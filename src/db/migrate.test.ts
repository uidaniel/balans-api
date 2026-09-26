import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checksumOf, sameMigration } from "./migrate.ts";

const unix = "ALTER TABLE users ADD COLUMN a TEXT;\n-- note\n";
const windows = unix.replace(/\n/g, "\r\n");
/** What the runner stored before it normalised: the file's bytes, hashed as they were. */
const raw = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test("a file hashes the same whatever line endings the checkout gave it", () => {
  assert.equal(checksumOf(unix), checksumOf(windows));
});

test("a row recorded from either kind of checkout still matches the file", () => {
  // 0022 in production: applied from Windows, read back on a Mac.
  assert.ok(sameMigration(raw(windows), unix));
  assert.ok(sameMigration(raw(unix), windows));
  assert.ok(sameMigration(checksumOf(windows), unix));
});

test("a real edit is still refused", () => {
  assert.ok(!sameMigration(checksumOf(unix), unix.replace("a TEXT", "b TEXT")));
  assert.ok(!sameMigration(raw(windows), unix.replace("a TEXT", "b TEXT")));
});
