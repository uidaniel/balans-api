/**
 * How a card is built, now that nothing is drawn around it.
 *
 * Every card in the product used to carry a rule above its rows and another
 * below them. One card reads fine. A thread of them — a draft, a reminder, a
 * payment, another draft — is mostly horizontal lines, and past the second or
 * third the eye stops reading them as separators and starts reading them as
 * noise.
 *
 * A blank line does the same work. WhatsApp already gives a bubble generous
 * line spacing, so a heading with air under it reads as a heading without
 * anything being drawn.
 *
 * This is pinned because nothing else pins it. Every one of these messages
 * had its rules removed and not a single test failed, which means the shape
 * of every card in the product was resting on nobody changing it by accident.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { block, row, b, rule } from "./format.ts";

describe("a card", () => {
  const card = block(`🧾 ${b("INVOICE DRAFT")}`, [
    row("Client", "Zenith Homes"),
    row("Amount", b("₦350,000")),
  ]);

  it("is a heading, a blank line, then the rows", () => {
    assert.equal(
      card,
      ["🧾 *INVOICE DRAFT*", "", "Client: Zenith Homes", "Amount: *₦350,000*"].join("\n"),
    );
  });

  it("draws nothing", () => {
    assert.doesNotMatch(card, /─|―|—{2,}|-{3,}|={3,}|_{3,}/, "no rules, and no substitute for one");
  });

  it("does not end on a blank line", () => {
    // A trailing gap inside a bubble reads as a message that did not finish.
    assert.doesNotMatch(card, /\n\s*$/);
  });

  it("leaves out rows that are not there, without leaving a gap", () => {
    // Callers pass `cond && row(...)`, so falsy rows are normal, not an edge.
    const sparse = block("TITLE", [row("Client", "Zenith"), false, null, undefined]);
    assert.equal(sparse, "TITLE\n\nClient: Zenith");
  });

  it("still separates the heading when there are no rows at all", () => {
    assert.equal(block("TITLE", []), "TITLE\n");
  });
});

describe("the rule", () => {
  it("is still available, and still box-drawing", () => {
    // Kept for anywhere a line is genuinely the right answer. A run of hyphens
    // is not the fallback: it reads as a torn edge, and WhatsApp turns some
    // hyphen runs into a strikethrough.
    assert.equal(rule(4), "────");
  });

  it("is not used to build cards any more", () => {
    assert.doesNotMatch(block("T", [row("A", "b")]), /─/);
  });
});
