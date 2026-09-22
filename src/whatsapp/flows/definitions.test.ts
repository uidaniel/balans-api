/**
 * The Flow JSON, checked before Meta sees it.
 *
 * Meta validates a Flow on publish and rejects the whole thing with one
 * message. That round trip needs a verified business, a published Flow and a
 * phone — none of which exist while this is being written — so the structural
 * mistakes that are cheap to make are worth catching here instead.
 *
 * What is checked is the wiring: that every screen a Footer navigates to
 * exists, that every `${data.x}` a screen uses is declared on that screen, and
 * that every `${form.x}` names an input on the same form. Those are the three
 * ways a Flow is wrong in a way TypeScript cannot see, because the whole thing
 * is `unknown` by the time it leaves here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FLOWS, PLANS, planIdFor, splitForPlan } from "./definitions.ts";
import { shapeFor } from "../../documents/parts.ts";

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;

/** Every object in a tree, in no particular order. */
function walk(value: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, out);
  } else if (isNode(value)) {
    out.push(value);
    for (const v of Object.values(value)) walk(v, out);
  }
  return out;
}

/** The names inside `${data.x}` / `${form.x}` references in a subtree. */
function refs(value: unknown, kind: "data" | "form"): string[] {
  const found = new Set<string>();
  const re = new RegExp(String.raw`\$\{${kind}\.([a-z_0-9]+)\}`, "gi");
  for (const node of walk(value)) {
    for (const v of Object.values(node)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(re)) found.add(m[1]!);
    }
  }
  return [...found];
}

describe("every published Flow", () => {
  for (const flow of FLOWS) {
    const json = flow.json as { version: string; screens: Node[] };

    describe(flow.key, () => {
      it("has a key, a name and at least one screen", () => {
        assert.ok(flow.key && flow.name, "a Flow with no name is unfindable in Meta's list");
        assert.ok(json.screens.length >= 1);
      });

      it("ends on a terminal screen and nowhere else", () => {
        const terminal = json.screens.filter((s) => s.terminal === true);
        assert.equal(terminal.length, 1, "exactly one screen may finish the Flow");
        assert.equal(
          terminal[0],
          json.screens.at(-1),
          "the terminal screen must be the last one",
        );
      });

      it("navigates only to screens that exist", () => {
        const ids = new Set(json.screens.map((s) => s.id));
        for (const node of walk(json.screens)) {
          if (node.name !== "navigate") continue;
          const next = (node.next as Node | undefined)?.name;
          assert.ok(
            typeof next === "string" && ids.has(next),
            `navigates to a screen that does not exist: ${String(next)}`,
          );
        }
      });

      it("only reads data each screen declares", () => {
        for (const screen of json.screens) {
          const declared = new Set(Object.keys((screen.data as Node) ?? {}));
          for (const name of refs(screen.layout, "data")) {
            assert.ok(
              declared.has(name),
              `${String(screen.id)} reads \${data.${name}} but never declares it`,
            );
          }
        }
      });

      it("only reads form fields that exist on that form", () => {
        for (const form of walk(json.screens).filter((n) => n.type === "Form")) {
          const inputs = new Set(
            walk(form.children)
              .filter((c) => typeof c.name === "string" && c.type !== "Footer")
              .map((c) => c.name as string),
          );
          for (const name of refs(form, "form")) {
            assert.ok(inputs.has(name), `\${form.${name}} is not an input on ${String(form.name)}`);
          }
        }
      });

      it("puts starting values on the form, not on the inputs", () => {
        // At 7.1 an `init-value` on a TextInput is rejected outright, and the
        // whole Flow fails to publish for it.
        for (const node of walk(json.screens)) {
          assert.equal(
            node["init-value"],
            undefined,
            `${String(node.name ?? node.type)} carries init-value`,
          );
        }
      });
    });
  }
});

describe("the payment plans a form can offer", () => {
  it("offers something shapeFor will actually accept", () => {
    // A list entry that `shapeFor` refuses is an invoice somebody filled in
    // and submitted, that then comes back as one payment without explanation.
    for (const plan of PLANS) {
      const split = splitForPlan(plan.id);
      if (plan.id === "one") {
        assert.equal(shapeFor(split), null, "one payment is no split at all");
        continue;
      }
      assert.notEqual(shapeFor(split), null, `${plan.id} produced nothing`);
    }
  });

  it("reads a deposit and a set of instalments apart", () => {
    assert.deepEqual(splitForPlan("deposit_50"), { depositPercent: 50, instalments: null });
    assert.deepEqual(splitForPlan("split_3"), { depositPercent: null, instalments: 3 });
    assert.deepEqual(splitForPlan("one"), { depositPercent: null, instalments: null });
  });

  it("treats anything it does not know as one payment", () => {
    for (const id of [null, undefined, "", "split_", "deposit_abc", "nonsense"]) {
      assert.deepEqual(splitForPlan(id), { depositPercent: null, instalments: null });
    }
  });

  it("reopens the form on the answer already given", () => {
    assert.equal(planIdFor({ depositPercent: 50 }), "deposit_50");
    assert.equal(planIdFor({ instalments: 3 }), "split_3");
    assert.equal(planIdFor({}), "one");
  });

  it("falls back to one payment for a split the list cannot say", () => {
    // "35% deposit" came from a sentence and has no entry. Opening the form on
    // "One payment" is honest; opening it on 25% would be a quiet edit.
    assert.equal(planIdFor({ depositPercent: 35 }), "one");
    assert.equal(planIdFor({ instalments: 7 }), "one");
  });

  it("round-trips every id it offers", () => {
    for (const plan of PLANS) {
      assert.equal(planIdFor(splitForPlan(plan.id)), plan.id);
    }
  });
});
