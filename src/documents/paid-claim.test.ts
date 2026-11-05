/** "I've paid" from the client: the sender is asked to check, never told it is paid. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claimText } from "./paid-claim.ts";
import { TEMPLATES } from "../whatsapp/window.ts";

describe("telling the sender their client says they paid", () => {
  it("asks them to check their bank", () => {
    const t = claimText("Zenith Homes", 12, "₦350,000");
    assert.match(t, /Zenith Homes says they've paid invoice #12/);
    assert.match(t, /check it's there/);
    assert.match(t, /won't remind them about it until you answer/);
  });

  it("has a utility template with the same two answers as the paid check", () => {
    const t = TEMPLATES.client_says_paid;
    assert.equal(t.category, "UTILITY");
    assert.deepEqual(t.quickReplies, ["Yes, mark paid", "Not yet"]);
    assert.equal(t.params.length, 3);
  });
});
