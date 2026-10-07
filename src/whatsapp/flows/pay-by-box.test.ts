/**
 * "How should your client pay?" on the invoice form (6 October 2026): a
 * Balans card link, or the sender's own details, for invoices not in naira.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { FLOWS } from "./definitions.ts";

type Node = Record<string, unknown> & { children?: Node[] };
const walk = (n: unknown): Node[] =>
  Array.isArray(n) ? n.flatMap(walk) : n && typeof n === "object" ? [n as Node, ...Object.values(n as object).flatMap(walk)] : [];

describe("the pay-by box", () => {
  const invoice = FLOWS.find((f) => f.key === "invoice")!.json as { screens: { id: string }[] };
  const terms = invoice.screens.find((s) => s.id === "TERMS")!;
  const nodes = walk(terms);

  it("is on the last screen, only for whoever can bill abroad", () => {
    const box = nodes.find((n) => n.name === "pay_by")!;
    assert.equal(box.type, "Dropdown");
    assert.equal(box.visible, "${data.can_bill_abroad}");
    assert.equal(box.required, false, "required while hidden would make the form unsendable");
    assert.deepEqual((box["data-source"] as { id: string }[]).map((o) => o.id), ["link", "own"]);
  });

  it("is sent back with the form", () => {
    const footer = nodes.find((n) => n.type === "Footer")!;
    const payload = (footer["on-click-action"] as { payload: Record<string, string> }).payload;
    assert.equal(payload.pay_by, "${form.pay_by}");
  });

  it("is read onto the draft, and nothing else is", () => {
    const handle = readFileSync(new URL("../../conversation/handle.ts", import.meta.url), "utf8");
    assert.match(handle, /payBy: fields\.pay_by === "own" \|\| fields\.pay_by === "link" \? fields\.pay_by : null/);
  });
});
