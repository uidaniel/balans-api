/**
 * What happens when the Free plan runs out.
 *
 * It used to happen in the wrong order. The limit was checked in `save_draft`
 * — the moment a filled-in form comes back — so someone on their sixth invoice
 * tapped "/invoice", got the form, typed a client, an amount and a due date,
 * submitted it, and only then read that they had run out. The work was thrown
 * away and the refusal read as a bug rather than as a plan.
 *
 * The check now runs before the form opens. It still runs in `save_draft` too,
 * because a typed invoice never passes through a form at all, and that is the
 * last point where refusing costs the person nothing.
 *
 * The message itself is a card, a caption and one button. The three carry
 * different things on purpose, which is what most of this file is about.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { limitReachedMessage, limitReachedCaption } from "./reports.ts";
import { LIMIT_CARD } from "../conversation/machine.ts";
import { defaults } from "../config.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the Free limit", () => {
  it("is checked before the form opens, not after it comes back", () => {
    const handle = read("../conversation/handle.ts");
    const flow = handle.indexOf('case "send_flow"');
    const id = handle.indexOf("await flowId(effect.key)", flow);
    const gate = handle.indexOf("await limitCard(", flow);

    assert.ok(gate > -1, "the flow path should ask about the limit at all");
    assert.ok(gate < id, "and ask before it goes looking for a form to send");
  });

  it("is checked again for an invoice that was typed, not tapped", () => {
    // A typed invoice never passes through send_flow.
    const handle = read("../conversation/handle.ts");
    const save = handle.indexOf('case "save_draft"');
    assert.ok(save > -1);
    assert.ok(
      handle.indexOf("await limitCard(", save) > -1,
      "the typed path still has to be stopped somewhere",
    );
  });

  it("does not gate onboarding behind a document limit", () => {
    // Someone mid-setup has no documents and no plan worth checking. Gating
    // it would lock them out of finishing their own account.
    const handle = read("../conversation/handle.ts");
    const flow = handle.indexOf('case "send_flow"');
    const gate = handle.slice(flow, flow + 1200);

    assert.match(gate, /effect\.key === "invoice"/);
    assert.doesNotMatch(gate.slice(0, gate.indexOf("await limitCard(")), /"onboarding"/);
  });
});

describe("the limit message", () => {
  const used = defaults.plans.free.documentsPerMonth!;
  const caption = limitReachedCaption(used, used);
  const words = limitReachedMessage(used, used);

  it("says how many, and when the count comes back", () => {
    for (const m of [caption, words]) {
      assert.match(m, new RegExp(String(used)), "the number they have sent");
      assert.match(m, /resets on the 1st/);
    }
  });

  it("promises that money already owed is safe", () => {
    // The line that matters most. Somebody stopped mid-invoice will wonder
    // whether what they are already owed is at risk.
    for (const m of [caption, words]) {
      assert.match(m, /already sent still work/);
    }
  });

  it("leaves the price and the offer to the card, in the caption", () => {
    // The poster above says "₦4,000 / month" and "REPLY UPGRADE", and a button
    // sits under it. Repeating either is the message arguing with itself.
    assert.doesNotMatch(caption, /4,000|upgrade/i);
  });

  it("carries the offer itself when there is no card", () => {
    // The words-only version has no picture behind it and no button under it.
    assert.match(words, /upgrade/i, "so it has to say what to reply");
  });

  it("points the card at a file the brand route will actually serve", () => {
    // A URL Meta cannot fetch is a message that fails to send at all.
    const name = LIMIT_CARD.split("/").pop()!;
    assert.match(LIMIT_CARD, /^https?:\/\//, "Meta fetches this by URL");
    assert.match(read("../http/routes/brand.ts"), new RegExp(`"${name}":`), "and it is on the map");
  });
});
