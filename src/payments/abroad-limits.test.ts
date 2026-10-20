/**
 * The ceilings on card payments from abroad (20 October 2026).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { defaults } from "../config.ts";

const intl = defaults.international;
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the day's ceiling", () => {
  it("is one figure across every currency, in naira at the dollar rate", () => {
    const h = src("../conversation/handle.ts");
    assert.match(h, /const dailyCapKobo = Math\.round\(caps\.USD \* 2 \* usd\.rate\)/);
    assert.match(h, /foreignNairaToday\(userId, today\)/);
    assert.match(src("../documents/queries.ts"), /AND currency <> 'NGN'/);
  });
});
