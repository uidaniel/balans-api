/**
 * The currency box on the invoice form (International PRD section 5).
 *
 * Until this existed, dollars were a typed-sentence feature. A Pro user who
 * upgraded in order to bill abroad could open `/invoice`, fill it in, and
 * find no way to say anything but naira — and the form does not go through
 * the state machine, so none of the guards written for a sentence ran on it.
 * A dollar amount typed into that form became a naira invoice with nothing
 * anywhere to say so.
 *
 * Three things here are load-bearing and each was checked against Meta before
 * being written, because the Flow JSON validator is the only feedback there
 * is and a Flow that compiles is not a Flow that works:
 *
 *   - `visible` bound to data is real. Meta names a property it does not know
 *     and refuses it — "Property 'visible_nonsense_xyz' is not allowed in
 *     'Dropdown' component" — so a property it accepts silently is one it
 *     recognises. That negative control is what makes the acceptance mean
 *     anything, and it is the same trap Monnify sets.
 *   - `helper-text` takes a data binding, so the line under Amount can say
 *     "Naira" to almost everybody and something true to the rest.
 *   - `init-value` on a Dropdown is refused outright, so the box cannot be
 *     pre-selected by the component. That is why an empty box has to mean
 *     "unchanged" rather than "naira" — see the last suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FLOWS } from "./definitions.ts";

type Screen = {
  id: string;
  data?: Record<string, unknown>;
  layout: { children: unknown[] };
};

const screensOf = (key: string): Screen[] =>
  ((FLOWS.find((f) => f.key === key)!.json as { screens: Screen[] }).screens);

/** Every component on a screen, however deeply nested. */
function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.type === "string") out.push(o);
    for (const v of Object.values(o)) walk(v, out);
  }
  return out;
}

const boxesOn = (s: Screen) => walk(s.layout.children);

describe("where the currency box is, and who sees it", () => {
  const work = screensOf("invoice").filter((s) => s.id === "WORK" || s.id.startsWith("WORK_"));

  it("is on every screen that has an Amount box", () => {
    /*
     * All five of them, not just the first. The form is one screen per number
     * of items and somebody who adds a line comes back to a different screen —
     * one that would otherwise have lost the choice they made on the last.
     */
    assert.ok(work.length >= 5, `only ${work.length} form screens`);
    for (const s of work) {
      const names = boxesOn(s).map((c) => c.name);
      assert.ok(names.includes("amount"), `${s.id} has no amount box`);
      assert.ok(names.includes("currency"), `${s.id} has no currency box`);
    }
  });

  it("sits directly above the Amount it applies to", () => {
    // The two are one decision. Anywhere else on the screen it reads as a
    // setting rather than as part of the price.
    for (const s of work) {
      const names = boxesOn(s)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string");
      assert.equal(
        names.indexOf("amount") - names.indexOf("currency"),
        1,
        `${s.id} separates the currency from the amount`,
      );
    }
  });

  it("is hidden unless the person opening it can use it", () => {
    /*
     * The form is one published definition and cannot be built per user, so
     * the box is always in the JSON and `visible` decides who sees it. For a
     * free account it is a field that exists only to be ignored, on a form
     * that is already long.
     */
    for (const s of work) {
      const box = boxesOn(s).find((c) => c.name === "currency")!;
      assert.equal(box.visible, "${data.can_bill_abroad}", `${s.id}`);
      assert.equal(box.required, false, "a hidden required field cannot be satisfied");
    }
  });

  it("offers the two currencies Balans takes, and naira", () => {
    const box = boxesOn(work[0]!).find((c) => c.name === "currency")!;
    const ids = (box["data-source"] as { id: string }[]).map((o) => o.id);
    assert.deepEqual(ids, ["NGN", "USD", "GBP"]);
  });

  it("does not use the component `init-value` Meta refuses", () => {
    // "Property 'init-value' is not allowed in 'Dropdown' component", proved
    // against Meta on 24 September 2026. The Form's `init-values` is the only
    // way, and every screen names the box there because that is the invariant
    // `definitions.test.ts` already enforces.
    for (const s of work) {
      const box = boxesOn(s).find((c) => c.name === "currency")!;
      assert.ok(!("init-value" in box), `${s.id} uses a property Meta rejects`);
    }
  });
});

describe("the line under the Amount box", () => {
  it("is not fixed text any more", () => {
    /*
     * "Naira, before VAT" is right for almost everybody and flatly wrong
     * above a box somebody has just set to dollars — and this is the one
     * sentence telling them what unit to type in.
     */
    for (const s of screensOf("invoice").filter((x) => x.id === "WORK" || x.id.startsWith("WORK_"))) {
      const amount = boxesOn(s).find((c) => c.name === "amount")!;
      assert.equal(amount["helper-text"], "${data.amount_help}", `${s.id}`);
    }
  });

  it("still says naira to everyone who cannot change it", () => {
    // The default the machine sends, which is what a free account and every
    // naira invoice gets.
    const machine = readFileSync(new URL("../../conversation/machine.ts", import.meta.url), "utf8");
    assert.match(machine, /NAIRA_HELP = "Naira, before VAT\. Digits only\."/);
    assert.match(machine, /amount_help: NAIRA_HELP/);
    assert.match(machine, /can_bill_abroad: false/);
  });
});

describe("what the form path does with it", () => {
  const handle = readFileSync(new URL("../../conversation/handle.ts", import.meta.url), "utf8");
  const fn = handle.slice(handle.indexOf("async function formCurrency"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  it("runs the same three gates a typed sentence runs", () => {
    /*
     * The form reaches `save_draft` without going near the machine, so none
     * of the guards written for a sentence apply to it. Each of these is one
     * of those guards, restated on this path because there is nowhere else
     * for it to live.
     */
    assert.match(body, /env\.INTL_ENABLED/, "the feature flag");
    assert.match(body, /planOf\(userId\)/, "Pro only");
    assert.match(body, /currentRate\(code/, "a locked rate, or no invoice");
  });

  it("refuses a currency the box could not have sent", () => {
    // It can only arrive from a replayed payload. Reading it as naira would
    // turn somebody's $2,000 into ₦2,000 for them.
    assert.match(body, /code !== "USD" && code !== "GBP"/);
    assert.match(body, /currencyNotTaken/);
  });

  it("treats an empty box as unchanged, not as naira", () => {
    /*
     * The failure this prevents is the worst one available here. Meta refuses
     * `init-value` on a Dropdown, so nothing has proved the box pre-selects on
     * a real phone. If it does not, somebody reopening a $500 draft to fix a
     * typo gets an empty box, taps Next, and the form says naira — a $500
     * invoice becomes a ₦500 one from an edit that never touched the money.
     *
     * Choosing naira deliberately sends "NGN", which is a different value
     * from nothing at all and is still honoured. The rule costs one explicit
     * tap; the other way round costs the invoice.
     */
    assert.match(
      handle,
      /\(fields\.currency \?\? ""\)\.trim\(\) \|\| \(open\?\.foreign\?\.currency \?\? ""\)/,
    );
  });

  it("converts through the same seam a sentence does", () => {
    // Above it a figure is in whatever currency was chosen; below it
    // everything is kobo. One conversion, at one recorded rate, and the form
    // does not get a second copy of that arithmetic.
    assert.match(handle, /repriced\(doc, abroad\.quote\)/);
  });

  it("keeps the priced draft in the conversation, not the form's copy", () => {
    // A correction typed at the summary is applied to whatever is held here.
    // The unpriced copy would put the dollar figures back as if they were
    // kobo, on the next thing the user said.
    assert.match(handle, /const context: Record<string, unknown> = \{ doc: priced \}/);
  });
});
