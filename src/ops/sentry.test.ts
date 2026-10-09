import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Sentry is fed from the error hook and sends no log objects", () => {
  const server = readFileSync(new URL("../http/server.ts", import.meta.url), "utf8");
  assert.match(server, /reportToSentry\(args\)/);
  const sentry = readFileSync(new URL("./sentry.ts", import.meta.url), "utf8");
  assert.match(sentry, /sendDefaultPii: false/);
  assert.match(sentry, /if \(on \|\| !env\.SENTRY_DSN\) return;/);
});
