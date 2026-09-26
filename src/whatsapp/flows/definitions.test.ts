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

      it("keeps every screen inside the two-link budget", () => {
        /*
         * "Maximum number of EmbeddedLink allowed per screen is 2 but found
         * 8." Counted across every branch of every Switch, not across what a
         * phone shows at once — and not caught reliably on publish. The Flow
         * went out with eight links on the form and answered "Something went
         * wrong. Try again later." when anybody opened it.
         *
         * That is why a link target is never chosen by branching: one link
         * per possible destination is four links before anything else.
         */
        for (const screen of json.screens) {
          const links = walk(screen.layout).filter((n) => n.type === "EmbeddedLink");
          assert.ok(
            links.length <= 2,
            `${String(screen.id)} has ${links.length} links: ${links.map((l) => l.text).join(", ")}`,
          );
        }
      });

      it("hands every screen exactly the data it declares", () => {
        /*
         * The failure this catches killed a live Flow, and it killed it one
         * tap after the mistake: "Something went wrong. Try again later.", a
         * blank screen, and no way to tell which key did it.
         *
         * Four flags were added to say which items exist. They travel between
         * the form and the item screens, and every route out to TERMS carried
         * them too \u2014 to a screen that had never heard of them. A payload key
         * the target does not declare is not ignored.
         *
         * The other direction is as fatal and easier to do by accident: a
         * screen that declares a field nobody sends it.
         */
        const byId = new Map(json.screens.map((s) => [String(s.id), s]));

        for (const screen of json.screens) {
          for (const node of walk(screen.layout)) {
            if (node.name !== "navigate") continue;

            const target = byId.get(String((node.next as Node | undefined)?.name));
            if (!target) continue;

            const declared = new Set(Object.keys((target.data as Node) ?? {}));
            const sent = new Set(Object.keys((node.payload as Node) ?? {}));
            const route = `${String(screen.id)} -> ${String(target.id)}`;

            for (const key of sent) {
              assert.ok(declared.has(key), `${route} sends ${key}, which it does not declare`);
            }
            for (const key of declared) {
              assert.ok(sent.has(key), `${route} never sends ${key}, which it declares`);
            }
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
  const TOTALS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
  const ITEM = (w: string) => `ITEM_${w.toUpperCase()}`;
  const FORM = (items: number) => `WORK_${TOTALS[items - 1]}`;

  for (const key of ["invoice", "quote"]) {
    const flow = FLOWS.find((f) => f.key === key)!;
    const json = flow.json as { screens: Node[] };
    const screen = (id: string) => json.screens.find((s) => s.id === id)!;
    const inputs = (id: string) =>
      walk(screen(id)).filter((n) => n.type === "TextInput" || n.type === "OptIn");
    const named = (id: string, name: string) => inputs(id).find((n) => n.name === name);
    const links = (id: string) => walk(screen(id)).filter((n) => n.type === "EmbeddedLink");
    const footer = (id: string) => walk(screen(id)).find((n) => n.type === "Footer")!;
    const action = (n: Node) => n["on-click-action"] as Node;
    const payloadOf = (n: Node) => (action(n).payload ?? {}) as Record<string, string>;
    const target = (n: Node) => ((action(n).next as Node).name as string) ?? "";
    const linkTo = (id: string, text: RegExp) => links(id).find((l) => text.test(String(l.text)));
    /** Every form screen: who it is for, the entry copy, then one per number of items. */
    const forms = () => ["WHO", "WORK", ...TOTALS.map((_, i) => FORM(i + 1))];

    describe(key, () => {
      /*
       * The one that cost three rounds of "Something went wrong. Try again
       * later." on a real phone.
       *
       * `init-values` may only name fields that are on the screen. The old
       * form put its item boxes inside Switch branches and named all eight of
       * them anyway, so six of the names pointed at fields that did not
       * exist whenever the invoice had fewer than five items — which is every
       * invoice. Meta publishes it without a word: the validator only checks
       * that each name appears somewhere in the JSON, which was confirmed by
       * probe against a throwaway Flow. The phone fails, and it fails one tap
       * later, on the next screen.
       *
       * Both directions, because the opposite mistake is just as bad in a
       * quieter way: a box with no starting value opens empty, and a form
       * somebody came back to would silently lose what was already typed.
       */
      it("names exactly the boxes that are on the screen, in init-values", () => {
        for (const s of json.screens) {
          const form = walk(s.layout).find((n) => n.type === "Form");
          const init = (form?.["init-values"] ?? {}) as Record<string, string>;
          const fields = new Set(
            walk(s.layout)
              .filter((n) => typeof n.name === "string" && /Input|TextArea|OptIn|Dropdown|DatePicker/.test(String(n.type)))
              .map((n) => String(n.name)),
          );

          for (const name of Object.keys(init)) {
            assert.ok(fields.has(name), `${s.id}: init-values names "${name}", which is not a field on it`);
          }
          /*
           * And the other direction, on the screens somebody comes back to:
           * a box with no starting value opens empty, so a form reopened on a
           * draft would quietly lose what was already typed into it.
           *
           * Only the form screens. An item screen is opened to add an item
           * that does not exist yet, and TERMS initialises its own four and
           * carries the rest.
           */
          if (!forms().includes(String(s.id))) continue;
          for (const name of fields) {
            assert.ok(init[name], `${s.id}: "${name}" is on screen with no starting value`);
          }
        }
      });

      /*
       * Nothing on these screens is conditional, and that is the design.
       *
       * A Switch is what made init-values lie, and it is what made the count
       * and the boxes able to disagree. One screen per number of items costs
       * two more screens (fifteen publish fine) and removes every way for a
       * screen to be handed something it is not showing.
       */
      it("decides what is on screen when it is built, not when it is opened", () => {
        for (const s of json.screens) {
          assert.equal(
            walk(s.layout).filter((n) => n.type === "Switch").length,
            0,
            `${s.id} still reshapes itself at runtime`,
          );
        }
      });

      it("gives each extra item a screen of its own", () => {
        for (const [index, w] of WORDS.entries()) {
          assert.ok(screen(ITEM(w)), `no screen for item ${w}`);
          assert.ok(named(ITEM(w), `item_${w}_description`));
          assert.ok(named(ITEM(w), `item_${w}_amount`));
          // Both required: you cannot create half an item. Clearing the boxes
          // on the form is how a whole one goes.
          assert.equal(named(ITEM(w), `item_${w}_description`)!.required, true);
          assert.equal(named(ITEM(w), `item_${w}_amount`)!.required, true);
          assert.equal(index + 2, index + 2);
        }
      });

      it("has one form screen per number of items, each showing all of them", () => {
        for (let items = 1; items <= 5; items++) {
          const id = FORM(items);
          assert.ok(screen(id), `no form screen for ${items} items`);
          // The first item is `description` / `amount`; the rest are named.
          assert.ok(named(id, "description"));
          assert.ok(named(id, "amount"));
          for (const [i, w] of WORDS.entries()) {
            const there = i < items - 1;
            assert.equal(
              Boolean(named(id, `item_${w}_description`)),
              there,
              `${id} ${there ? "is missing" : "should not have"} item ${i + 2}`,
            );
          }
          // Editable, not a read-out. The first attempt disabled these, which
          // put somebody's own typo behind glass.
          for (const n of inputs(id)) assert.notEqual(n.enabled, false);
        }
        // The entry copy is the one-item form with a number pad on Amount.
        assert.equal(named("WORK", "amount")!["input-type"], "number");
        assert.equal(named(FORM(1), "amount")!["input-type"], "text");
      });

      it("adds by going one screen forward and removes by going one back", () => {
        for (let items = 1; items <= 5; items++) {
          const id = FORM(items);
          const add = linkTo(id, /add another item/i);
          const remove = linkTo(id, /^remove item/i);

          if (items < 5) assert.equal(target(add!), ITEM(WORDS[items - 1]!), `${id} adds the wrong item`);
          else assert.equal(add, undefined, "the five-item form has nothing left to add");

          if (items > 1) {
            assert.equal(String(remove!.text), `Remove item ${items}`);
            assert.equal(target(remove!), FORM(items - 1), `${id} removes to the wrong screen`);
          } else {
            assert.equal(remove, undefined, "a one-item invoice has nothing to remove");
          }
        }
        assert.equal(target(linkTo("WORK", /add another item/i)!), ITEM("two"));
      });

      it("hands a saved item to the form that has room for it", () => {
        for (const [index, w] of WORDS.entries()) {
          const save = footer(ITEM(w));
          assert.equal(String(save.label), "Save item");
          assert.equal(target(save), FORM(index + 2));
          // Its own two out of the form; everything else exactly as it came.
          const p = payloadOf(save);
          assert.equal(p[`item_${w}_description`], `\${form.item_${w}_description}`);
          assert.equal(p[`item_${w}_amount`], `\${form.item_${w}_amount}`);

          // And the way out leaves nothing behind.
          const back = linkTo(ITEM(w), /^remove item/i)!;
          assert.equal(target(back), FORM(index + 1));
          assert.ok(!(`item_${w}_description` in payloadOf(back)));
        }
      });

      it("reads every box on the form back out of the form", () => {
        /*
         * An item read from `data` while its box is on screen shows the edit,
         * accepts it, and sends the old value — losing an item wearing a
         * disguise. So a screen that renders a field reads that field.
         */
        for (let items = 1; items <= 5; items++) {
          const id = FORM(items);
          const shown = inputs(id).map((n) => String(n.name));
          for (const n of [...links(id), footer(id)]) {
            const p = payloadOf(n);
            const keep =
              /^remove item/i.test(String(n.text)) ? shown.slice(0, -2) : shown;
            for (const name of keep) {
              if (!(name in p)) continue;
              assert.equal(p[name], `\${form.${name}}`, `${id} "${n.text ?? n.label}" reads ${name} from data`);
            }
          }
        }
      });

      it("carries every item all the way to the submit", () => {
        // The last screen sends the whole document, so every slot has to
        // arrive even when the invoice never used it.
        const submit = footer("TERMS");
        assert.equal(action(submit).name, "complete");
        for (const w of WORDS) {
          assert.equal(payloadOf(submit)[`item_${w}_description`], `\${data.item_${w}_description}`);
          assert.equal(payloadOf(submit)[`item_${w}_amount`], `\${data.item_${w}_amount}`);
        }
        // And each form screen fills the slots it does not have with the
        // empty strings TERMS declares, rather than leaving them out.
        for (let items = 1; items <= 5; items++) {
          const p = payloadOf(footer(FORM(items)));
          for (const w of WORDS.slice(items - 1)) {
            assert.equal(p[`item_${w}_description`], "");
            assert.equal(p[`item_${w}_amount`], "");
          }
        }
      });

      it("gives every item a quantity, above its amount, all the way to the submit", () => {
        /*
         * The sentence always read "4 stills at 20k" and every template
         * always printed a quantity; only the form could not say one. Each
         * item's box sits directly above its Amount, because a quantity is
         * what turns Amount into the price of one.
         */
        const order = (id: string) => inputs(id).map((n) => n.name as string);
        const above = (id: string, qty: string, amount: string) => {
          const names = order(id);
          const q = names.indexOf(qty);
          assert.ok(q >= 0, `${id} has no ${qty}`);
          assert.ok(q < names.indexOf(amount), `${id}: ${qty} should come before ${amount}`);
          assert.equal(named(id, qty)!.required, false, "optional: empty means one");
        };
        for (const id of forms().slice(1)) above(id, "qty", "amount");
        for (let items = 2; items <= 5; items++) {
          for (const w of WORDS.slice(0, items - 1)) above(FORM(items), `item_${w}_qty`, `item_${w}_amount`);
        }
        for (const w of WORDS) above(ITEM(w), `item_${w}_qty`, `item_${w}_amount`);
        // The number pad where the data is a number, as for Amount.
        assert.equal(named("WORK", "qty")!["input-type"], "number");
        assert.equal(named(FORM(1), "qty")!["input-type"], "text");

        const submit = payloadOf(footer("TERMS"));
        assert.equal(submit.qty, "${data.qty}");
        for (const w of WORDS) assert.equal(submit[`item_${w}_qty`], `\${data.item_${w}_qty}`);
        // Saving an item hands its quantity to the form it returns to.
        for (const w of WORDS) assert.equal(payloadOf(footer(ITEM(w)))[`item_${w}_qty`], `\${form.item_${w}_qty}`);
      });

      it("asks who it is for on its own page, first", () => {
        const who = screen("WHO");
        assert.deepEqual(
          inputs("WHO").map((n) => n.name),
          ["client_name", "client_email", "client_phone"],
        );
        assert.equal(named("WHO", "client_name")!.required, true);
        assert.equal(named("WHO", "client_phone")!["input-type"], "phone");
        assert.equal(named("WHO", "client_phone")!.required, false);
        assert.equal(json.screens[0], who, "the first page is the first screen");
        // And hands on to the item page, reading its own three from the form.
        const next = footer("WHO");
        assert.equal(target(next), "WORK");
        for (const f of ["client_name", "client_email", "client_phone"]) {
          assert.equal(payloadOf(next)[f], `\${form.${f}}`);
        }
        // Nothing about the client is asked again on the item pages.
        for (const id of forms().slice(1)) {
          assert.equal(named(id, "client_name"), undefined, `${id} asks for the client again`);
        }
      });

      it("picks the date on a calendar that starts today", () => {
        for (const id of forms().slice(1)) {
          const picker = walk(screen(id)).find((n) => n.name === "due_date")!;
          assert.equal(picker.type, "DatePicker", `${id} still takes the date as words`);
          assert.equal(picker["min-date"], "${data.today}");
        }
      });

      it("no longer offers to pass the fee to the client", () => {
        assert.ok(!walk(json).some((n) => n.name === "pass_fees"));
        assert.ok(!JSON.stringify(json).includes("pass_fees"));
      });

      it("keeps every screen inside the two-link budget", () => {
        /*
         * Probed against Meta on 23 September 2026: at most two EmbeddedLinks
         * on a rendered screen. The error message reports the total across
         * every Switch branch, which is why this once looked like a budget
         * for the whole Flow.
         */
        for (const s of json.screens) {
          assert.ok(
            walk(s.layout).filter((n) => n.type === "EmbeddedLink").length <= 2,
            `${s.id} holds more than two links`,
          );
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
