/**
 * The staging copy shares the live box's network so Caddy can reach it. On
 * 9 October 2026 its compose service was called "api" — the live API's
 * address on that network — and Caddy split live traffic between the two:
 * messages to the main number were answered from the test number.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("./docker-compose.staging.yml", import.meta.url), "utf8");
const deploy = readFileSync(new URL("./deploy.sh", import.meta.url), "utf8");
const caddy = readFileSync(new URL("./Caddyfile", import.meta.url), "utf8");

describe("staging never answers for the live API", () => {
  it("has no service called api", () => {
    assert.doesNotMatch(compose, /^\s{2}api:\s*$/m);
    assert.match(compose, /^\s{2}staging-api:\s*$/m);
  });
  it("is reached by its own name, which is not the live one", () => {
    assert.match(caddy, /reverse_proxy balans-staging-api:4000/);
    assert.match(caddy, /reverse_proxy api:4000/);
  });
  it("is stopped by the deploy if it ever answers to api", () => {
    assert.match(deploy, /grep -q ' api '/);
    assert.match(deploy, /SERVICE=staging-api/);
  });
});
