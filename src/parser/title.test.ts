/**
 * A title on a document (9 October 2026), said in a message or a correction,
 * taken out before the rest is read so it never lands in the description.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { titleIn, readCorrection } from "./corrections.ts";

const today = { y: 2026, m: 10, d: 9 };

describe("titleIn", () => {
  const cases: [string, string | null, string][] = [
    ["invoice Acme 500k for the website, title: Phase 1 redesign", "Phase 1 redesign", "invoice Acme 500k for the website"],
    ["invoice Acme 500k for the website, titled Phase 2, due friday", "Phase 2", "invoice Acme 500k for the website, due friday"],
    ["change the title to September retainer", "September retainer", ""],
    ['title: "Brand refresh"', "Brand refresh", ""],
  ];
  for (const [text, title, rest] of cases) {
    it(text, () => {
      const got = titleIn(text);
      assert.equal(got?.title, title);
      assert.equal(got?.rest, rest);
    });
  }

  it("takes a title off", () => {
    assert.equal(titleIn("remove the title")?.title, null);
    assert.equal(titleIn("no title")?.title, null);
  });

  it("leaves a message with no title alone", () => {
    assert.equal(titleIn("invoice Acme 500k for the website redesign"), null);
    assert.equal(titleIn("invoice Tunde 20k for a book title design"), null);
  });
});

describe("as a correction", () => {
  it("sets it", () => assert.equal(readCorrection("change the title to Phase 2", today)?.title, "Phase 2"));
  it("sets it beside another change", () => {
    const c = readCorrection("title: Phase 2, due friday", today);
    assert.equal(c?.title, "Phase 2");
  });
});
