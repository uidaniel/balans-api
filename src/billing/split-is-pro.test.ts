/**
 * Deposits and milestone payments are Pro (29 September 2026).
 *
 * The draft step is the one place every document passes through — a typed
 * message, a correction and the form alike — so the rule is pinned there.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLANS } from "../whatsapp/flows/definitions.ts";
import { proOffer } from "./messages.ts";

const handle = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");

describe("deposits and milestones", () => {
  it("are left off a Free draft, which says why, and kept on Pro", () => {
    assert.match(handle, /const splitAllowed = !splitAsked \|\| gate\.plan === "pro";/);
    assert.match(handle, /if \(!splitAllowed\) \{\s*extra\.push\(splitIsPro\(\)\);/);
    // Cleared before the draft is written, not after.
    const gate = handle.indexOf("const splitAllowed");
    const draft = handle.indexOf("const draft = await createDraft(userId, {");
    assert.ok(gate > 0 && gate < draft, "the Pro check must run before the draft is created");
  });

  it("are marked Pro on the form, within a dropdown's 30 characters", () => {
    for (const p of PLANS) {
      assert.ok(p.title.length <= 30, p.title);
      assert.equal(p.id === "one", !p.title.includes("(Pro)"), p.title);
    }
  });

  it("are sold in the upgrade offer", () => {
    assert.match(proOffer(1), /Deposits and milestone payments/);
  });
});
