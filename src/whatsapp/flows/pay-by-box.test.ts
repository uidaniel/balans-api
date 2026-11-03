/**
 * "Paid by", on non-naira invoices only (2 November 2026).
 *
 * It was taken off on 31 October: on the last screen it showed on naira
 * invoices too, and moved under the Amount behind a condition on the
 * currency, WhatsApp would not show it at all. It is back on PAYMENT, shown
 * by the server: the amount screen asks it (data_exchange), and it switches
 * the box on with data, the way the Currency box is shown, which works.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { FLOWS, PAYMENT_SCREEN, payByOptions, termsKeys } from "./definitions.ts";
import { paymentStep } from "./endpoint.ts";

type Node = Record<string, unknown>;
const walk = (n: unknown, out: Node[] = []): Node[] => {
  if (Array.isArray(n)) n.forEach((x) => walk(x, out));
  else if (n && typeof n === "object") {
    out.push(n as Node);
    Object.values(n).forEach((x) => walk(x, out));
  }
  return out;
};

describe("the pay-by box", () => {
  for (const key of ["invoice", "quote"]) {
    it(`${key}: sits on PAYMENT, shown and required only when the server says`, () => {
      const json = FLOWS.find((f) => f.key === key)!.json as { screens: Node[]; routing_model: Record<string, string[]> };
      const box = walk(json.screens.find((s) => s.id === PAYMENT_SCREEN)).find((n) => n.name === "pay_by")!;
      assert.equal(box.type, "RadioButtonsGroup");
      assert.equal(box.visible, "${data.show_pay_by}");
      assert.equal(box.required, "${data.show_pay_by}");
      // No condition on the phone anywhere near it.
      assert.ok(!walk(json).some((n) => n.type === "If" && String(n.condition).includes("currency")));
    });

    it(`${key}: the amount screens ask the server, which routes to PAYMENT`, () => {
      const json = FLOWS.find((f) => f.key === key)!.json as { data_api_version?: string; routing_model: Record<string, string[]> };
      assert.equal(json.data_api_version, "3.0");
      for (const id of ["WORK", "WORK_NEW", "WORK_ONE", "WORK_FIVE"]) {
        assert.ok(json.routing_model[id]?.includes(PAYMENT_SCREEN), `${id} cannot reach PAYMENT`);
      }
    });
  }

  it("is not on the payment request form", () => {
    assert.doesNotMatch(JSON.stringify(FLOWS.find((f) => f.key === "request")!.json), /pay_by/);
  });

  it("offers a card link, their own details, and their bank, even before they have one", () => {
    // Without one, the link under the list adds it (2 November 2026).
    const none = payByOptions({ bank: null, details: null });
    // Their own details last (2 November 2026).
    assert.deepEqual(none.map((o) => o.id), ["link", "bank", "own"]);
    assert.equal(none[1]!.description, "Add it with the link below");
    const some = payByOptions({ bank: "GTBank ·· 1234", details: "paypal: ada@x.com" });
    assert.equal(some[1]!.description, "GTBank ·· 1234");
  });

  for (const key of ["invoice", "quote"]) {
    it(`${key}: "My own details" opens a box for them, on the same screen`, () => {
      const json = FLOWS.find((f) => f.key === key)!.json as { screens: Node[] };
      const screen = json.screens.find((s) => s.id === PAYMENT_SCREEN)!;
      const branch = walk(screen).find((n) => n.type === "If" && n.condition === "${form.pay_by} == 'own'")!;
      const box = walk(branch).find((n) => n.name === "own_details")!;
      assert.equal(box.type, "TextArea");
      // Neutral: their choice of how to be paid, no services named.
      assert.doesNotMatch(JSON.stringify(screen), /PayPal|Wise/);
      // A box inside an If is never named in init-values.
      const form = walk(screen).find((n) => n.type === "Form")!;
      assert.ok(!("own_details" in ((form["init-values"] as object) ?? {})));
    });

    it(`${key}: the add-bank link opens a page, shown only by the server`, () => {
      const json = FLOWS.find((f) => f.key === key)!.json as { screens: Node[] };
      const link = walk(json.screens.find((s) => s.id === PAYMENT_SCREEN)).find((n) => n.type === "EmbeddedLink")!;
      assert.equal(link.visible, "${data.show_add_bank}");
      assert.deepEqual(link["on-click-action"], { name: "open_url", url: "${data.add_bank_url}" });
    });
  }

  it("reads their bank or own details in any currency, the card link only for others", () => {
    const handle = readFileSync(new URL("../../conversation/handle.ts", import.meta.url), "utf8");
    assert.match(handle, /fields\.pay_by === "own" \|\| fields\.pay_by === "bank" \|\| \(fields\.pay_by === "link" && fields\.currency && fields\.currency !== "NGN"\)/);
  });

  it("has no card link for naira (2 November 2026)", () => {
    assert.deepEqual(payByOptions({ bank: null, details: null, naira: true }).map((o) => o.id), ["bank", "own"]);
  });
});

describe("what the server answers the amount screen with", () => {
  const sent = Object.fromEntries(termsKeys().map((k) => [k, k === "vat" ? false : ""]));

  it("offers their bank first on a naira invoice, and hands everything else on", async () => {
    const out = (await paymentStep("u1", { ...sent, currency: "NGN", amount: "50000" }, { actions: { isAbroad: async () => false } })) as {
      screen: string;
      data: Record<string, unknown>;
    };
    assert.equal(out.screen, PAYMENT_SCREEN);
    assert.equal(out.data.show_pay_by, true);
    assert.deepEqual((out.data.pay_bys as { id: string }[]).map((o) => o.id), ["bank", "own"]);
    assert.equal(out.data.pay_by, "bank");
    assert.equal(out.data.amount, "50000");
    // Exactly what PAYMENT declares, no more.
    assert.deepEqual(Object.keys(out.data).sort(), termsKeys().sort());
  });

  it("abroad, offers only their own details, so the Details box can take them (3 November 2026)", async () => {
    const out = (await paymentStep("u1", { ...sent, currency: "GHS" }, { actions: { isAbroad: async () => true } })) as { data: Record<string, unknown> };
    assert.equal(out.data.show_pay_by, true);
    assert.deepEqual((out.data.pay_bys as { id: string }[]).map((o) => o.id), ["own"]);
    assert.equal(out.data.pay_by, "own");
    assert.equal(out.data.show_add_bank, false);
    // Nigeria's 7.5% VAT is hidden and off abroad.
    assert.equal(out.data.show_vat, false);
    assert.equal(out.data.vat, "false");
  });
});
