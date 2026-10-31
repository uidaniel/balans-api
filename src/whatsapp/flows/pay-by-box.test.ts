/**
 * "How should your client pay?" on the invoice form (6 October 2026): a
 * Balans card link, or the sender's own details, for invoices not in naira.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { FLOWS, payByOptions } from "./definitions.ts";

type Node = Record<string, unknown> & { children?: Node[] };
const walk = (n: unknown): Node[] =>
  Array.isArray(n) ? n.flatMap(walk) : n && typeof n === "object" ? [n as Node, ...Object.values(n as object).flatMap(walk)] : [];

describe("the pay-by box", () => {
  const invoice = FLOWS.find((f) => f.key === "invoice")!.json as { screens: { id: string }[] };
  const terms = invoice.screens.find((s) => s.id === "TERMS")!;
  const nodes = walk(terms);

  it("is on the last screen, only on an invoice priced in another currency", () => {
    const box = nodes.find((n) => n.name === "pay_by")!;
    assert.equal(box.type, "Dropdown");
    // Not on a naira invoice (31 October 2026), where its only option said
    // "Not for naira".
    const gate = nodes.find((n) => n.type === "If" && JSON.stringify(n).includes('"pay_by"')) as { condition?: string } | undefined;
    assert.match(String(gate?.condition), /can_bill_abroad/);
    assert.match(String(gate?.condition), /currency\} != 'NGN'/);
    assert.equal(box.required, false, "required while hidden would make the form unsendable");
    assert.equal(box["data-source"], "${data.pay_options}");
  });

  it("names their bank, and leaves it off when they have none", () => {
    const withBank = payByOptions({ bank: "Access Bank ••5673", details: "PayPal: me@x.com" });
    assert.deepEqual(withBank.map((o) => o.id), ["bank", "own", "link"]);
    assert.equal(withBank[0]!.description, "Access Bank ••5673");
    assert.equal(withBank[1]!.description, "PayPal: me@x.com");
    // No Nigerian account: no card link either, since it settles to one.
    assert.deepEqual(payByOptions({ bank: null, details: null }).map((o) => o.id), ["own"]);
    for (const o of withBank) assert.ok(o.title.length <= 30, o.title);
  });

  it("is sent back with the form", () => {
    const footer = nodes.find((n) => n.type === "Footer")!;
    const payload = (footer["on-click-action"] as { payload: Record<string, string> }).payload;
    assert.equal(payload.pay_by, "${form.pay_by}");
  });

  it("is read onto the draft, and nothing else is", () => {
    const handle = readFileSync(new URL("../../conversation/handle.ts", import.meta.url), "utf8");
    assert.match(handle, /payBy: fields\.pay_by === "own" \|\| fields\.pay_by === "link" \|\| fields\.pay_by === "bank" \? fields\.pay_by : null/);
  });
});
