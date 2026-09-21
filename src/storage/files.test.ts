/**
 * File names.
 *
 * F20: "Invoice-14-Zenith-Homes.pdf. Strip characters unsafe for file names."
 * Unsafe is a longer list than it looks — a quote or a semicolon breaks the
 * Content-Disposition header itself, which is worse than an awkward name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentKey, fileName, receiptKey } from "./files.ts";

describe("naming a downloaded file", () => {
  it("reads the way the PRD writes it", () => {
    assert.equal(fileName("Invoice", 14, "Zenith Homes"), "Invoice-14-Zenith-Homes.pdf");
    assert.equal(fileName("Quote", 3, "Tunde"), "Quote-3-Tunde.pdf");
    assert.equal(fileName("Receipt", 21, "Kemi Studio"), "Receipt-21-Kemi-Studio.pdf");
  });

  it("copes with no number, which a sample has", () => {
    assert.equal(fileName("Invoice", null, "Zenith Homes"), "Invoice-Zenith-Homes.pdf");
  });

  it("strips what a filesystem or a header would argue with", () => {
    for (const bad of [
      'Zenith "Homes"',
      "Zenith/Homes",
      "Zenith\Homes",
      "Zenith:Homes",
      "Zenith*Homes?",
      "Zenith<Homes>",
      "Zenith|Homes",
      "Zenith;Homes",
      "Zenith\nHomes",
    ]) {
      const name = fileName("Invoice", 1, bad);
      assert.doesNotMatch(name, /["\/:*?<>|;\n\r]/, `${JSON.stringify(bad)} -> ${name}`);
      assert.match(name, /^Invoice-1-.+\.pdf$/, name);
    }
  });

  it("drops accents and non-Latin script rather than emitting them", () => {
    // A header is ASCII, and a Windows filesystem is not reliably UTF-8.
    assert.equal(fileName("Invoice", 2, "Adébáyò Òjó"), "Invoice-2-Adebayo-Ojo.pdf");
    assert.equal(fileName("Invoice", 3, "日本の会社"), "Invoice-3-Client.pdf");
    assert.equal(fileName("Invoice", 4, "Zenith 🏠 Homes"), "Invoice-4-Zenith-Homes.pdf");
  });

  it("keeps the name short enough to be a name", () => {
    const long = "The Very Long Name Of A Nigerian Limited Liability Company Plc";
    const name = fileName("Invoice", 5, long);
    assert.ok(name.length < 60, name);
    assert.equal(name, "Invoice-5-The-Very-Long-Name.pdf");
  });

  it("never produces a name that is only the extension", () => {
    assert.equal(fileName("Invoice", 6, ""), "Invoice-6-Client.pdf");
    assert.equal(fileName("Invoice", 7, "   "), "Invoice-7-Client.pdf");
    assert.equal(fileName("Invoice", 8, "!!!"), "Invoice-8-Client.pdf");
  });
});

describe("storage keys", () => {
  it("are shaped like the bucket paths they will become", () => {
    assert.equal(
      documentKey("11111111-1111-1111-1111-111111111111", 2),
      "documents/11111111-1111-1111-1111-111111111111/v2.pdf",
    );
    assert.equal(receiptKey("22222222-2222-2222-2222-222222222222"),
      "receipts/22222222-2222-2222-2222-222222222222.pdf");
  });

  it("give each version its own key, so an edit keeps the old one", () => {
    // F20: every version of an edited document is kept.
    const id = "11111111-1111-1111-1111-111111111111";
    assert.notEqual(documentKey(id, 1), documentKey(id, 2));
  });
});
