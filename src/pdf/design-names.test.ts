import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DESIGN_WORDS } from "./design-names.ts";
import { TEMPLATES } from "./templates.ts";

describe("the words that name a design", () => {
  it("are exactly the ready designs' ids and names", () => {
    const words = new Set(TEMPLATES.filter((t) => t.ready).flatMap((t) => [t.id, t.name.toLowerCase()]));
    assert.deepEqual([...DESIGN_WORDS].sort(), [...words].sort());
  });
});
