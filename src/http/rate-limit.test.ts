import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "./server.ts";

test("checkout opens are limited per visitor; health checks never are", async () => {
  const app = buildServer();
  await app.ready();
  try {
    for (let n = 0; n < 320; n++) {
      const r = await app.inject({ method: "GET", url: "/health" });
      assert.equal(r.statusCode, 200);
    }
    const codes: number[] = [];
    for (let n = 0; n < 11; n++) {
      const r = await app.inject({ method: "GET", url: "/pro/start", headers: { "cf-connecting-ip": "203.0.113.9" } });
      codes.push(r.statusCode);
    }
    assert.equal(codes[9], 404);
    assert.equal(codes[10], 429);
    // Somebody else is not caught by the first visitor's limit.
    const other = await app.inject({ method: "GET", url: "/pro/start", headers: { "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(other.statusCode, 404);
  } finally {
    await app.close();
  }
});
