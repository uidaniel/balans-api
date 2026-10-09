import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikePayDetails } from "./handle.ts";

test("payment details are recognised", () => {
  for (const t of [
    "PayPal: kemi@gmail.com",
    "Wise: IBAN GB00 0000 0000 0000 00, Kemi Adeyemi",
    "Sort code 12-34-56, account 12345678",
    "Grey USD account 0123456789",
    "M-Pesa 0712 345 678",
  ]) assert.equal(looksLikePayDetails(t), true, t);
});

test("ordinary chat is not saved as payment details", () => {
  for (const t of ["Invoice Tunde 20k for logo", "use the link instead", "hello", "ok thanks", "make it 400k"])
    assert.equal(looksLikePayDetails(t), false, t);
});
