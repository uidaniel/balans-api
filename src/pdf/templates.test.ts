/**
 * The invoice layouts, and the page that offers them.
 *
 * What is actually worth testing here is not how any of them look — that is a
 * judgement — but the promises they all make regardless of looks: the client's
 * name is on it, the total is on it, section 12's lines are on it, and the
 * things that must never appear never do.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { availableTo, renderTemplate, TEMPLATES, templateById } from "./templates.ts";
import type { DocumentData } from "./template.ts";
import { pickerPage } from "../http/routes/templates.ts";

const DOC: DocumentData = {
  variant: "invoice",
  number: 14,
  businessName: "Ada Studio",
  businessEmail: "ada@example.com",
  businessAddress: "12 Adeola Odeku, Lagos",
  businessTin: "12345678-0001",
  logoDataUri: null,
  clientName: "Zenith Homes",
  clientEmail: "pay@zenith.example",
  lines: [
    { description: "Exterior 3D render", qty: 1, unitAmountKobo: 250_000_00, amountKobo: 250_000_00 },
    { description: "Interior stills", qty: 4, unitAmountKobo: 20_000_00, amountKobo: 80_000_00 },
  ],
  subtotalKobo: 330_000_00,
  vatKobo: 0,
  vatPercent: null,
  totalKobo: 330_000_00,
  amountPaidKobo: 0,
  issueDate: { y: 2026, m: 9, d: 21 },
  dueDate: { y: 2026, m: 10, d: 5 },
  notes: null,
  publicUrl: "https://payment.balans.ng/i/abc123",
  legalLines: [
    "Balans is a product of Balans Technologies Ltd. Balans is not a bank and does not hold customer funds.",
    "Payments are processed by Monnify and settle directly to the merchant's bank account.",
  ],
  showMadeWith: true,
};

const ready = TEMPLATES.filter((t) => t.ready);

test("the registry", async (t) => {
  await t.test("offers at least one design on the Free plan", () => {
    assert.ok(availableTo("free").length >= 1);
  });

  await t.test("offers a Free user everything a Pro user has, minus the Pro ones", () => {
    const free = availableTo("free");
    const pro = availableTo("pro");
    assert.ok(free.every((t) => pro.some((p) => p.id === t.id)));
    assert.ok(free.every((t) => !t.pro));
    assert.ok(pro.length > free.length, "Pro must be worth paying for");
  });

  await t.test("never offers one that is not ported yet", () => {
    assert.ok(availableTo("pro").every((t) => t.ready));
  });

  await t.test("falls back rather than failing on an unknown id", () => {
    assert.equal(templateById("no-such-design").id, "classic");
    assert.equal(templateById(null).id, "classic");
    assert.equal(templateById(undefined).id, "classic");
    // A layout that is withdrawn must not strand the people already on it.
    for (const spec of TEMPLATES.filter((t) => !t.ready)) {
      assert.equal(templateById(spec.id).id, "classic", `${spec.id} is withdrawn`);
    }
  });

  await t.test("has no two entries claiming the same id", () => {
    const ids = TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test("every layout", async (t) => {
  for (const spec of ready) {
    await t.test(`${spec.name} says who is being billed and for how much`, () => {
      const html = renderTemplate(spec.id, DOC);
      assert.ok(html, `${spec.id} renders`);
      assert.match(html, /Zenith Homes/);
      assert.match(html, /Ada Studio/);
      // The total, written the way money is written here.
      assert.ok(html.includes("330,000"), `${spec.id} shows the total`);
      assert.match(html, /Exterior 3D render/);
    });

    await t.test(`${spec.name} carries the two lines section 12 requires`, () => {
      const html = renderTemplate(spec.id, DOC)!;
      assert.ok(html.includes("is not a bank and does not hold customer funds"));
      assert.ok(html.includes("Payments are processed by Monnify"));
    });

    await t.test(`${spec.name} fetches nothing`, () => {
      const html = renderTemplate(spec.id, DOC)!;
      // A render that reaches out can hang, and hangs on a PDF that somebody
      // is waiting for in a chat.
      assert.doesNotMatch(html, /<link[^>]+href=/i, "no stylesheet link");
      assert.doesNotMatch(html, /<script/i, "no script");
      assert.doesNotMatch(html, /src="https?:/i, "nothing fetched over the wire");
      assert.doesNotMatch(html, /@import/i, "no imported stylesheet");
    });

    await t.test(`${spec.name} survives a document with almost nothing on it`, () => {
      const bare: DocumentData = {
        ...DOC,
        number: null,
        businessEmail: null,
        businessAddress: null,
        businessTin: null,
        clientEmail: null,
        issueDate: null,
        dueDate: null,
        publicUrl: null,
        lines: [{ description: "Work", qty: 1, unitAmountKobo: 5000_00, amountKobo: 5000_00 }],
        subtotalKobo: 5000_00,
        totalKobo: 5000_00,
      };
      const html = renderTemplate(spec.id, bare);
      assert.ok(html && html.includes("Work"));
      assert.doesNotMatch(html, /undefined|null|NaN/);
    });

    await t.test(`${spec.name} escapes what the user typed`, () => {
      const nasty = { ...DOC, clientName: `<script>alert(1)</script>`, businessName: `Ada & "Co"` };
      const html = renderTemplate(spec.id, nasty)!;
      assert.doesNotMatch(html, /<script>alert/);
      assert.ok(html.includes("&amp;"));
    });

    await t.test(`${spec.name} drops the Balans line on Pro`, () => {
      const paid = renderTemplate(spec.id, { ...DOC, showMadeWith: false })!;
      assert.ok(!paid.includes("Made with Balans"));
      assert.ok(renderTemplate(spec.id, DOC)!.includes("Made with Balans"));
    });
  }
});

test("the design picker", async (t) => {
  const page = (plan: "free" | "pro", chosenId: string | null = null, savedId?: string) =>
    pickerPage({ token: "a".repeat(32), plan, chosenId, sample: DOC, savedId });

  await t.test("shows every ready layout, whatever the plan", () => {
    const html = page("free");
    for (const spec of ready) assert.ok(html.includes(spec.name), `${spec.name} is shown`);
  });

  await t.test("does not offer a Free user a Pro layout", () => {
    const html = page("free");
    const pro = ready.filter((s) => s.pro);
    assert.ok(pro.length > 0, "there is something to withhold");
    for (const spec of pro) {
      assert.ok(!html.includes(`value="${spec.id}"`), `${spec.id} has no submit button`);
    }
    assert.ok(html.includes("Reply <b>upgrade</b>"), "it says how to get them");
  });

  await t.test("offers a Pro user all of them", () => {
    const html = page("pro");
    for (const spec of ready) assert.ok(html.includes(`value="${spec.id}"`), `${spec.id} is offered`);
  });

  await t.test("marks the one in use and does not offer to set it again", () => {
    const html = page("pro", "ledger");
    assert.ok(html.includes("Using this"));
    assert.equal((html.match(/Using this/g) ?? []).length, 1, "exactly one is current");
  });

  await t.test("falls back to Classic when nothing has been chosen", () => {
    assert.ok(page("free", null).includes("Using this"));
  });

  await t.test("previews the real layouts, not pictures of them", () => {
    const html = page("pro");
    assert.equal((html.match(/<iframe/g) ?? []).length, ready.length);
    // Sandboxed, because the sheet inside is built from names the user typed.
    assert.equal((html.match(/sandbox="allow-same-origin"/g) ?? []).length, ready.length);
    // Never with allow-scripts: that pair lets a frame remove its own sandbox.
    assert.doesNotMatch(html, /allow-scripts/);
    assert.ok(html.includes('srcdoc="<!doctype html>'), "the whole sheet rides in the attribute");
    assert.ok(!/srcdoc="[^"]*"[^">]*"/.test(html), "no quote escapes out of the attribute");
  });

  await t.test("confirms a choice in words, not just a highlight", () => {
    assert.ok(page("pro", "ledger", "ledger").includes("Saved."));
    assert.ok(!page("pro", "ledger").includes("Saved."));
  });

  await t.test("keeps the page out of search results", () => {
    assert.ok(page("free").includes("noindex"));
  });

  await t.test("says the change is not retrospective", () => {
    // Somebody who has sent an invoice this morning needs to know it did not
    // just change under them.
    assert.match(page("free"), /already sent do not change/);
  });
});
