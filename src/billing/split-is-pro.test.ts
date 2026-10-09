/**
 * Deposits and milestone payments, on every plan (9 October 2026). They were
 * Pro from 29 September; this pins that nothing takes them off a Free draft.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLANS } from "../whatsapp/flows/definitions.ts";
import { proOffer } from "./messages.ts";
import { proPoints } from "./pro-cards.ts";

const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");

describe("deposits and milestones", () => {
  it("are not taken off a Free draft", () => {
    assert.doesNotMatch(handle, /splitAllowed|splitIsPro/);
    assert.doesNotMatch(handle, /payment plan left off: free plan/);
  });

  it("fit a dropdown's 30 characters, with no '(Pro)' on them", () => {
    for (const p of PLANS) {
      assert.ok(p.title.length <= 30, p.title);
      assert.ok(!p.title.includes("(Pro)"), p.title);
    }
  });

  it("are not sold as Pro", () => {
    assert.doesNotMatch(proOffer(1), /Deposits and milestone/);
    assert.ok(!proPoints().some((p) => /deposit|milestone/i.test(p)));
  });
});
