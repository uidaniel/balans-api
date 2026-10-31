/**
 * There is no "Paid by" box on the invoice and quote forms (31 October 2026).
 *
 * It was on the last screen and showed on naira invoices too, with its one
 * option saying "Not for naira"; moved under the Amount, WhatsApp would not
 * show it at all. A foreign invoice takes the sender's default from settings,
 * and "pay by card link" or "to my PayPal" typed in the chat still changes it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { FLOWS } from "./definitions.ts";

describe("the pay-by box", () => {
  it("is on none of the document forms", () => {
    for (const key of ["invoice", "quote", "request"]) {
      const json = JSON.stringify(FLOWS.find((f) => f.key === key)!.json);
      assert.doesNotMatch(json, /pay_by|pay_options/, key);
    }
  });

  it("is still read from a form opened before, and from what is typed", () => {
    const handle = readFileSync(new URL("../../conversation/handle.ts", import.meta.url), "utf8");
    assert.match(handle, /payBy: fields\.pay_by === "own" \|\| fields\.pay_by === "link" \|\| fields\.pay_by === "bank" \? fields\.pay_by : null/);
  });
});
