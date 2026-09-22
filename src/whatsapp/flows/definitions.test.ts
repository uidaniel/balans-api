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
import { FLOW_BANKS, OTHER_BANK, bankOptions } from "./banks.ts";
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

      it("declares data with the type of the field it fills", () => {
        /*
         * Meta refuses the whole Flow for this, and it is invisible here:
         *
         *   Expected property 'amount' to be of type 'number' but found
         *   'string'.
         *
         * The amount input is `input-type: "number"`, so the `data` entry
         * that initialises it has to be a number too. Nothing in the JSON
         * says those two belong together, which is exactly why it was wrong.
         */
        const WANTS: Record<string, string> = {
          number: "number",
          text: "string",
          email: "string",
          password: "string",
          passcode: "string",
          phone: "string",
        };

        for (const screen of json.screens) {
          const declared = (screen.data as Record<string, Node>) ?? {};

          for (const form of walk(screen.layout).filter((n) => n.type === "Form")) {
            const init = (form["init-values"] as Record<string, string>) ?? {};
            const inputs = new Map(
              walk(form.children)
                .filter((c) => typeof c.name === "string")
                .map((c) => [c.name as string, c]),
            );

            for (const [field, ref] of Object.entries(init)) {
              const name = /^\$\{data\.([a-z_0-9]+)\}$/i.exec(ref)?.[1];
              if (!name) continue;

              const input = inputs.get(field);
              // An OptIn is a checkbox: it has no input-type and its value is
              // a boolean, which is also what it has to be initialised with.
              const wanted =
                input?.type === "OptIn"
                  ? "boolean"
                  : WANTS[String(input?.["input-type"] ?? "text")];
              assert.equal(
                declared[name]?.type,
                wanted,
                `${String(screen.id)}: data.${name} fills ${field}, which wants a ${wanted}`,
              );
            }
          }
        }
      });

      it("declares a value carried from a form as a string", () => {
        /*
         * The other direction, and the one that cost a real phone an error.
         *
         * A field declared `input-type: "number"` must be declared a number on
         * the screen that INITIALISES it — Meta's publish validator insists.
         * But the value that comes back OUT of that same field, through a
         * Footer's `${form.x}` payload, arrives at the next screen as a
         * string. Declaring it a number there passes publish and then fails
         * when somebody taps Next:
         *
         *   [key=data.amount] in object should be of type <number>, but got
         *   <string>.
         *
         * So: anything a screen receives from a previous screen's form is a
         * string, whatever kind of input produced it.
         */
        const byId = new Map(json.screens.map((s) => [String(s.id), s]));

        for (const screen of json.screens) {
          for (const node of walk(screen.layout)) {
            if (node.name !== "navigate") continue;

            const target = byId.get(String((node.next as Node | undefined)?.name));
            if (!target) continue;

            const declared = (target.data as Record<string, Node>) ?? {};
            for (const [key, ref] of Object.entries((node.payload as Record<string, string>) ?? {})) {
              if (!/^\$\{form\.[a-z_0-9]+\}$/i.test(ref)) continue;
              assert.equal(
                declared[key]?.type,
                "string",
                `${String(target.id)}: data.${key} comes from ${ref}, which arrives as a string`,
              );
            }
          }
        }
      });

      it("keeps input labels short enough not to wrap", () => {
        /*
         * An input's label sits in a narrow left column, and a long one wraps
         * onto two lines while the field beside it stays on one. It looks
         * broken rather than long.
         *
         * "Business name" wrapped on a real phone; "Email address" did not, at
         * the same character count. So the column is roughly twelve characters
         * of ordinary text and the exact point depends on the glyphs — which
         * means the limit here is deliberately well under it rather than up
         * against it.
         *
         * OptIn is excluded: a checkbox label runs the full width of the
         * screen, so length is not a problem there. Footer is a button.
         */
        const NARROW = new Set(["TextInput", "TextArea", "Dropdown", "DatePicker"]);

        for (const node of walk(json.screens)) {
          if (!NARROW.has(String(node.type))) continue;
          const label = String(node.label ?? "");
          assert.ok(
            label.length <= 10,
            `${String(node.name)}: "${label}" is ${label.length} characters and will wrap`,
          );
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

describe("the bank dropdown", () => {
  const rows = bankOptions();

  it("offers every bank on the list, once", () => {
    assert.equal(rows.length, FLOW_BANKS.length);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "a bank appears twice");
  });

  it("is alphabetical, ignoring capitals", () => {
    // Ignoring capitals matters: a plain sort puts every all-caps name
    // (FCMB, GTBank, UBA) in a block before the lower-case ones, which is not
    // alphabetical to anyone looking for their bank.
    const names = rows.slice(0, -1).map((r) => r.title);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    assert.deepEqual(names, sorted);
  });

  it("keeps Other at the bottom", () => {
    // Sorted into the O's it sits between Optimus and Palmpay and gets tapped
    // by somebody scanning for their own bank.
    assert.equal(rows.at(-1)?.id, OTHER_BANK);
    assert.equal(rows.filter((r) => r.id === OTHER_BANK).length, 1);
  });

  it("does not reorder the source list", () => {
    // `sort` mutates. If it ever reached FLOW_BANKS itself, the grouping that
    // makes the list readable to edit would quietly disappear.
    const before = [...FLOW_BANKS];
    bankOptions();
    assert.deepEqual([...FLOW_BANKS], before);
  });

  it("uses the display name as the id", () => {
    // What comes back from the form is matched to a live Monnify code by
    // `matchBank`, so the value has to be something it can read.
    for (const r of rows) assert.equal(r.id, r.title);
  });
});
