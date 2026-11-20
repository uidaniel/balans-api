/** /health says which build is answering (20 November 2026). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import Fastify from "fastify";
import { healthRoutes } from "./routes/health.ts";

describe("/health", () => {
  it("names the build, and is still only a liveness check", async () => {
    const app = Fastify();
    await app.register(healthRoutes);
    const r = await app.inject({ method: "GET", url: "/health" });
    const body = r.json() as { ok: boolean; version: string };
    assert.equal(r.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.ok(body.version.length > 0);
    await app.close();
  });

  it("is told the commit by the deploy, before the build", () => {
    const script = readFileSync(new URL("../../deploy/deploy.sh", import.meta.url), "utf8");
    const write = script.indexOf('echo "$AFTER" > "$APP/VERSION"');
    assert.ok(write > 0 && write < script.indexOf('build "$SERVICE"'));
  });
});
