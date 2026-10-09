import { test } from "node:test";
import assert from "node:assert/strict";
import { asCommand } from "./commands.ts";

test("the part-payment button and typed deposit replies are read", () => {
  assert.equal(asCommand("yes mark invoice 16 part paid")?.intent, "confirm_part_payment");
  assert.equal(asCommand("yes mark invoice 16 part paid")?.documentNumber, 16);
  assert.equal(asCommand("yes mark invoice 16 paid")?.intent, "confirm_payment");
  assert.equal(asCommand("deposit paid on invoice 16")?.intent, "record_payment");
  assert.equal(asCommand("deposit paid on invoice 16")?.documentNumber, 16);
  assert.equal(asCommand("balance paid for invoice 3")?.intent, "record_payment");
});
