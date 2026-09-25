import assert from "node:assert/strict";
import { it } from "node:test";

import { documentLink } from "./links.ts";

it("sends a quote to balans.ng/q/, and everything else to its payment page", () => {
  // A quote is read and agreed to; only the invoice it becomes is paid.
  assert.match(documentLink("quote", "tok"), /^https?:\/\/[^/]+\/q\/tok$/);
  assert.doesNotMatch(documentLink("quote", "tok"), /payment\./);
  assert.match(documentLink("invoice", "tok"), /\/i\/tok$/);
  assert.match(documentLink("payment_request", "tok"), /\/i\/tok$/);
});
