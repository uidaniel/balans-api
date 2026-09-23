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

      it("hands a carried value on as the type the next screen declares", () => {
        /*
         * The third face of the same trap, and the one nothing was watching.
         *
         * The two tests above cover a value going into an input and a value
         * coming back out of one. This is the value that does neither: a
         * screen passing `${data.x}` straight through to the next screen.
         * Nothing casts it, so if the two screens disagree about its type the
         * Flow publishes and then fails on the phone at the tap that carries
         * it — which is how five screens of line items would have gone wrong,
         * quietly, on the fourth item.
         */
        const byId = new Map(json.screens.map((s) => [String(s.id), s]));

        for (const screen of json.screens) {
          const mine = (screen.data as Record<string, Node>) ?? {};

          for (const node of walk(screen.layout)) {
            if (node.name !== "navigate") continue;

            const target = byId.get(String((node.next as Node | undefined)?.name));
            if (!target) continue;
            const theirs = (target.data as Record<string, Node>) ?? {};

            for (const [key, ref] of Object.entries((node.payload as Record<string, string>) ?? {})) {
              const from = /^\$\{data\.([a-z_0-9]+)\}$/i.exec(ref)?.[1];
              if (!from || !mine[from] || !theirs[key]) continue;
              assert.equal(
                theirs[key]?.type,
                mine[from]?.type,
                `${String(screen.id)} sends data.${from} (${String(mine[from]?.type)}) to ` +
                  `${String(target.id)}.${key}, which is declared ${String(theirs[key]?.type)}`,
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
        assert.equal(shapeFor(split, 100_000_00), null, "one payment is no split at all");
        continue;
      }
      assert.notEqual(shapeFor(split, 100_000_00), null, `${plan.id} produced nothing`);
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

/**
 * More than one thing on an invoice.
 *
 * The form held one description and one amount, so billing for three things
 * meant a sentence or one squashed line — "logo, website and business cards"
 * at a single price. Flow JSON has no repeater and `update_data` is not an
 * action at 7.1, so the rows all exist in the JSON and checkboxes decide
 * which are on screen.
 *
 * That makes the wiring the whole feature, and most of it is invisible to
 * TypeScript: everything below `json` is `unknown`.
 */
describe("line items on the document forms", () => {
  const WORDS = ["two", "three", "four", "five"];
  const SCREEN = (w: string) => `ITEM_${w.toUpperCase()}`;

  for (const key of ["invoice", "quote"]) {
    const flow = FLOWS.find((f) => f.key === key)!;
    const json = flow.json as { screens: Node[] };
    const screen = (id: string) => json.screens.find((s) => s.id === id)!;
    const inputs = (id: string) =>
      walk(screen(id)).filter((n) => n.type === "TextInput" || n.type === "OptIn");
    const named = (id: string, name: string) => inputs(id).find((n) => n.name === name);
    const links = (id: string) => walk(screen(id)).filter((n) => n.type === "EmbeddedLink");
    const action = (n: Node) => n["on-click-action"] as Node;
    const payloadOf = (n: Node) => (action(n).payload ?? {}) as Record<string, string>;
    const footer = (id: string) => walk(screen(id)).find((n) => n.type === "Footer")!;

    describe(key, () => {
      it("gives each extra item a screen of its own", () => {
        /*
         * Not five slots on one screen. That was the first attempt, each slot
         * behind `visible: "${form.add_two}"`, and Meta's validator accepted
         * it — but a phone ignores `visible`, so an invoice with one line
         * opened showing four empty Work/Amount pairs under it.
         */
        for (const w of WORDS) {
          assert.ok(screen(SCREEN(w)), `no screen for item ${w}`);
          assert.ok(named(SCREEN(w), `item_${w}_description`), `no description field for item ${w}`);
          assert.ok(named(SCREEN(w), `item_${w}_amount`), `no amount field for item ${w}`);
        }
      });

      it("shows one item and nothing else until somebody asks", () => {
        // The form opens on the invoice most people are writing.
        const names = inputs("WORK").map((n) => n.name);
        assert.ok(!names.some((n) => typeof n === "string" && n.startsWith("item_")));
      });

      it("offers the next item as a link, never a checkbox", () => {
        /*
         * Navigation is the only thing that reliably changes what is on a
         * screen without a data endpoint: `update_data` is not an action at
         * 7.1, probed against Meta on 23 September 2026.
         *
         * The first item is added from the form; every one after it from the
         * form the item screens hand their work back to. So both copies of
         * the form offer the link, and the item screens offer nothing but a
         * way home.
         */
        const first = links("WORK").find((n) => action(n).name === "navigate");
        assert.ok(first, "the form offers no way to add an item");
        assert.equal(first!.text, "Add another item");
        assert.equal((action(first!).next as Node).name, SCREEN(WORDS[0]!));

        // Coming back, where the link points depends on how many items there
        // already are, which is the whole reason for the Switch.
        const cases = (walk(screen("WORK_AGAIN")).find((n) => n.type === "Switch")!.cases ??
          {}) as Record<string, Node[]>;

        WORDS.forEach((_, index) => {
          const branch = cases[WORDS[index]!];
          assert.ok(branch, `no branch for ${index + 2} items`);
          const link = branch!.find((n) => n.type === "EmbeddedLink");
          const next = WORDS[index + 1];
          if (next) {
            assert.equal((action(link!).next as Node).name, SCREEN(next), `${index + 2} items`);
          } else {
            // And the last one does not pretend there is a sixth.
            assert.equal(link, undefined, "a sixth item is offered");
          }
        });

        // An item screen collects one item. Leaving it is the Footer's job.
        for (const w of WORDS) assert.equal(links(SCREEN(w)).length, 0, `item ${w} has a link`);
      });

      it("never makes an item required", () => {
        // An item nobody filled in is not an item, and a required field on a
        // screen somebody opened by accident is a form they cannot leave.
        for (const w of WORDS) {
          assert.notEqual(named(SCREEN(w), `item_${w}_description`)!.required, true, `item ${w}`);
          assert.notEqual(named(SCREEN(w), `item_${w}_amount`)!.required, true, `item ${w}`);
        }
      });

      it("hands every item back to the form rather than past it", () => {
        /*
         * The bug this replaced, found on a real phone within an hour of the
         * item screens going live: add a second item, tap back to check the
         * client name, tap Next, and the second item is gone.
         *
         * A Flow with no data endpoint has no memory across the back arrow \u2014
         * the earlier screen is restored with the data it was pushed with \u2014
         * and a Footer's destination is fixed at publish, so the form could
         * neither remember the item nor route around it. Now every item screen
         * returns to the form, and the form holds the lot.
         */
        WORDS.forEach((w, index) => {
          const f = footer(SCREEN(w));
          assert.equal(action(f).name, "navigate");
          assert.equal((action(f).next as Node).name, "WORK_AGAIN", `item ${w}`);
          // A literal, because this is the screen that knows: saving item
          // three is what makes an invoice three items long.
          assert.equal(payloadOf(f).item_count, w, `item ${w} miscounts`);
        });

        // And the form is the only thing that ends the first half.
        for (const id of ["WORK", "WORK_AGAIN"]) {
          assert.equal((action(footer(id)).next as Node).name, "TERMS", id);
        }
      });

      it("shows what has already been added", () => {
        // The other half of the same complaint: somebody who added an item
        // had no way to see it again. Each branch of the Switch reads back
        // every item up to its own count.
        const cases = (walk(screen("WORK_AGAIN")).find((n) => n.type === "Switch")!.cases ??
          {}) as Record<string, Node[]>;

        WORDS.forEach((_, index) => {
          const text = (cases[WORDS[index]!] ?? [])
            .filter((n) => n.type === "TextCaption")
            .map((n) => String(n.text))
            .join(" ");
          for (let i = 0; i <= index; i++) {
            assert.match(text, new RegExp(`item_${WORDS[i]}_description`), `${index + 2} items`);
            assert.match(text, new RegExp(`item_${WORDS[i]}_amount`), `${index + 2} items`);
          }
        });
      });

      it("declares every amount a string except the one it fills", () => {
        /*
         * Both halves of the trap at once.
         *
         * A `input-type: "number"` input must be initialised from a number —
         * Meta refuses to publish otherwise. What comes back out of that same
         * input is a string. So the money travels between screens as a string
         * under `item_two_amount`, and the starting value rides separately
         * under `item_two_amount_init`, which is a number and is dropped once
         * the screen that needed it has been through.
         */
        for (const w of WORDS) {
          for (const id of ["WORK", "WORK_AGAIN", "TERMS", ...WORDS.map(SCREEN)]) {
            const data = screen(id).data as Record<string, { type: string }>;
            assert.equal(data[`item_${w}_amount`]!.type, "string", `${id} item ${w}`);
          }
        }

        for (const w of WORDS) {
          const own = screen(SCREEN(w)).data as Record<string, { type: string }>;
          assert.equal(own[`item_${w}_amount_init`]!.type, "number", `${SCREEN(w)} starts item ${w}`);

          /*
           * Carried everywhere now, where they used to be dropped once spent.
           * The form is reachable again after any item, so there is no longer
           * a point in the journey where one of these is safely behind us.
           */
          for (const id of ["WORK", "WORK_AGAIN", ...WORDS.map(SCREEN)]) {
            const data = screen(id).data as Record<string, { type: string }>;
            assert.equal(data[`item_${w}_amount_init`]!.type, "number", `${id} lost the start for ${w}`);
          }

          const terms = screen("TERMS").data as Record<string, unknown>;
          assert.equal(terms[`item_${w}_amount_init`], undefined, `TERMS declares a start for ${w}`);
        }
      });

      it("carries every item along every route", () => {
        /*
         * The one that matters for money. A correction arrives with three
         * lines and somebody taps Next on the first screen without opening
         * the others. Every payload has to pass on what it is not editing, or
         * those lines are gone and nothing said so.
         */
        const routes: Node[] = [];
        for (const id of ["WORK", "WORK_AGAIN", ...WORDS.map(SCREEN)]) {
          routes.push(footer(id), ...links(id));
        }

        for (const node of routes) {
          const payload = payloadOf(node);
          const editing = WORDS.find(
            (w) => payload[`item_${w}_amount`] === `\${form.item_${w}_amount}`,
          );
          for (const w of WORDS) {
            const want = w === editing ? "form" : "data";
            assert.equal(payload[`item_${w}_description`], `\${${want}.item_${w}_description}`);
            assert.equal(payload[`item_${w}_amount`], `\${${want}.item_${w}_amount}`);
          }
        }
      });

      it("carries every item all the way to the submit", () => {
        // A field that stops at a screen boundary is a line item somebody
        // typed and never saw again.
        const complete = walk(screen("TERMS")).find(
          (n) => isNode(n["on-click-action"]) && (n["on-click-action"] as Node).name === "complete",
        );
        const payload = (complete!["on-click-action"] as Node).payload as Record<string, string>;

        for (const w of WORDS) {
          assert.equal(payload[`item_${w}_description`], `\${data.item_${w}_description}`);
          assert.equal(payload[`item_${w}_amount`], `\${data.item_${w}_amount}`);
        }
      });

      it("opens each item screen on what the draft already has", () => {
        // The correction path. Without an init-value the field comes up empty
        // and the submit drops the line it was meant to be correcting.
        for (const w of WORDS) {
          const form = walk(screen(SCREEN(w))).find((n) => n.type === "Form")!;
          const init = form["init-values"] as Record<string, string>;
          assert.equal(init[`item_${w}_description`], `\${data.item_${w}_description}`);
          assert.equal(init[`item_${w}_amount`], `\${data.item_${w}_amount_init}`);
        }
      });
    });
  }

  it("leaves the payment request alone", () => {
    /*
     * A request is "a lightweight payable with no PDF" — there is no document
     * for a second line to print on, and adding one would be inventing the
     * paperwork its whole point is not having.
     */
    const request = FLOWS.find((f) => f.key === "request")!;
    const names = walk(request.json).map((n) => n.name);
    assert.ok(!names.some((n) => typeof n === "string" && n.startsWith("item_")));
  });
});
