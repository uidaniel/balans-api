/**
 * An email address in an invoice message goes to the client's email, never
 * into their name or the work (30 September 2026: "invoice Edidiong Uwak
 * ed@x.com $1 for Website Development" made a client named with the address).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "./parse.ts";

const today = { y: 2026, m: 9, d: 30 };

describe("an email in an invoice message", () => {
  const cases: [string, string, string][] = [
    ["invoice Edidiong Uwak ed@gmail.com $1 for Website Development", "Edidiong Uwak", "ed@gmail.com"],
    ["invoice Edidiong Uwak, ed@gmail.com, $1 for Website Development", "Edidiong Uwak", "ed@gmail.com"],
    ["invoice ed@gmail.com Edidiong Uwak 50k for logo", "Edidiong Uwak", "ed@gmail.com"],
    ["invoice Tunde (tunde@x.ng) 50k for logo", "Tunde", "tunde@x.ng"],
    ["invoice Tunde <tunde@x.ng> 50k for logo", "Tunde", "tunde@x.ng"],
    ["invoice Tunde 50k for logo, email tunde@x.ng", "Tunde", "tunde@x.ng"],
    ["invoice Tunde 50k for logo, her email is tunde.a@x.ng", "Tunde", "tunde.a@x.ng"],
    ["invoice Tunde 50k for logo send to tunde@x.ng", "Tunde", "tunde@x.ng"],
    ["invoice Tunde 50k for logo due friday, email: tunde@x.ng", "Tunde", "tunde@x.ng"],
  ];
  for (const [text, name, email] of cases) {
    it(text, async () => {
      const r = await parseMessage(text, { today });
      assert.ok(r.ok, "not understood");
      const p = r.parsed;
      assert.equal(p.clientName, name);
      assert.equal(p.clientEmail, email);
      for (const l of p.lineItems) assert.doesNotMatch(l.description, /@/, "the email leaked into the work");
    });
  }

  it("leaves a message with no email alone", async () => {
    const r = await parseMessage("invoice Tunde 50k for logo", { today });
    assert.ok(r.ok);
    assert.equal(r.parsed.clientName, "Tunde");
    assert.equal(r.parsed.clientEmail, null);
  });
});
