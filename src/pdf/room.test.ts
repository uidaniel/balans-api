/**
 * Big amounts and square logos (20 October 2026).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { rows, items } from "./kit.ts";
import type { DocumentData } from "./template.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const doc = (kobo: number): DocumentData =>
  ({
    lines: [{ description: "Render", qty: 1, unitAmountKobo: kobo, amountKobo: kobo }],
  }) as DocumentData;

describe("the amount columns", () => {
  it("ask for as much room as the widest figure needs", () => {
    // "₦50,000,000" is 11 characters: 11 × 0.6 + 0.2.
    assert.match(rows(doc(50_000_000_00)), /--un:6\.8em;--an:6\.8em/);
    assert.match(items(doc(50_000_000_00)), /--un:6\.8em;--an:6\.8em/);
  });

  it("never go narrower than the layout drew them", () => {
    const kit = src("./kit.ts");
    assert.match(kit, /\.rows \.u\{width:max\(var\(--un,0em\),4\.6em\)/);
    assert.match(kit, /\.rows \.a\{width:max\(var\(--an,0em\),5em\)/);
    assert.match(kit, /\.items \.a\{width:max\(var\(--an,0em\),7\.4em\)/);
  });

  it("let a fixed-width totals block grow rather than spill", () => {
    for (const f of ["./templates.ts", "./templates-plus.ts"]) {
      for (const line of src(f).split("\n").filter((l) => l.includes(".sums{"))) {
        assert.doesNotMatch(line, /(?<![-\w])width:\d/, line);
      }
    }
  });
});

describe("a square logo", () => {
  it("is rounded on the pay page and in the client's email, never a circle", () => {
    assert.match(src("../documents/page.ts"), /\.own-logo\.tile\{border-radius:22%\}/);
    assert.match(src("../email/layout.ts"), /brand\.rounded \? "border-radius:10px;"/);
  });

  it("is a tile only when roughly square with four solid corners", () => {
    const chrome = src("./chrome.ts");
    assert.match(chrome, /w \/ h < 0\.8 \|\| w \/ h > 1\.25/);
    assert.match(chrome, /data\[3\] > 245/);
  });
});
