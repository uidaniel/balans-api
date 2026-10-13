import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shapeFor, stagesFor } from "../documents/parts.ts";
import { planIdFor } from "../whatsapp/flows/definitions.ts";

/*
 * The Deposit box under "Custom deposit" (13 October 2026). `readDeposit`
 * lives in handle.ts, which needs a database to import, so the reading is
 * mirrored by what it hands on: a percent or a sum, and the shape of each.
 */
describe("a custom deposit", () => {
  it("as a sum is that exact sum, then the balance", () => {
    assert.deepEqual(shapeFor({ depositKobo: 100_000_00 }, 800_000_00), [
      { label: "Deposit", amountKobo: 100_000_00 },
      { label: "Balance", amountKobo: 700_000_00 },
    ]);
  });

  it("is not a deposit when it is the whole invoice or more", () => {
    assert.equal(shapeFor({ depositKobo: 800_000_00 }, 800_000_00), null);
    assert.equal(shapeFor({ depositKobo: 0 }, 800_000_00), null);
  });

  it("wins over a percent when both are set", () => {
    assert.equal(shapeFor({ depositKobo: 100_000_00, depositPercent: 50 }, 800_000_00)?.[0]?.amountKobo, 100_000_00);
  });

  it("has no dates when none were said", () => {
    const stages = stagesFor({ depositKobo: 100_000_00, dueDate: null }, 800_000_00, { y: 2026, m: 10, d: 13 });
    assert.deepEqual(stages?.map((s) => s.dueOn), [null, null]);
  });

  it("reopens the form on Custom deposit", () => {
    assert.equal(planIdFor({ depositKobo: 100_000_00 }), "deposit_custom");
    assert.equal(planIdFor({ depositPercent: 30 }), "deposit_custom");
    assert.equal(planIdFor({ depositPercent: 50 }), "deposit_50");
  });
});
