/** Each kind of email from its own address (4 November 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressFor } from "./send.ts";

describe("which address an email comes from", () => {
  it("is the kind of mail it is, on our domain", () => {
    const before = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = "Balans <onboarding@balans.ng>";
    try {
      assert.equal(addressFor("invoicing"), "invoicing@balans.ng");
      assert.equal(addressFor("disputes"), "disputes@balans.ng");
      assert.equal(addressFor("support"), "support@balans.ng");
      assert.equal(addressFor(), "onboarding@balans.ng");
    } finally {
      if (before === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = before;
    }
  });
});
