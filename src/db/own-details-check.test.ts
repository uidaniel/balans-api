/**
 * "My own details" invoices could not be sent (fixed 4 November 2026): 0034
 * added 'own_details' to delivery_type but 0024's check still allowed only a
 * link or a full bank stamp. 0068 allows the third kind, with its details.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("./migrations/", import.meta.url);

describe("the document delivery check", () => {
  it("allows own details, with the details, in the latest definition", () => {
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .filter((sql) => /ADD CONSTRAINT documents_bank_details_complete/.test(sql))
      .at(-1)!;
    assert.match(latest, /delivery_type = 'own_details' AND payment_details IS NOT NULL/);
    assert.match(latest, /delivery_type = 'payment_link'/);
    assert.match(latest, /bank_details_account_number_encrypted IS NOT NULL/);
  });
});
