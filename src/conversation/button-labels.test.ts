/**
 * What a button is allowed to say.
 *
 * Buttons carried emoji everywhere — a tick on "Send it", a bin on "Discard",
 * a receipt on "New invoice". WhatsApp already draws a button as a button, so
 * the glyph decorated something that was never ambiguous, and three of them
 * stacked read as clutter rather than as help.
 *
 * One exception, and it is not decoration. The account-name check asks "That's
 * me / Not me", and it is the one question in the product where tapping the
 * wrong answer sends somebody's money to the wrong bank account. The tick and
 * the cross separate the two at a glance, for someone reading quickly.
 *
 * Written down because the rule is a judgement, not a convention: the next
 * person adding a button will reach for an emoji unless something says not to,
 * and the exception looks like an oversight unless something says why.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VOICE } from "./machine.ts";
import { helpButtons } from "./menu.ts";
import { draftButtons } from "../documents/summary.ts";

const EMOJI = /\p{Extended_Pictographic}/u;

describe("button labels", () => {
  it("carry no emoji", () => {
    const every = [
      ...helpButtons(),
      ...draftButtons(),
      ...VOICE.codeButtons(),
      ...VOICE.consentButtons(),
      ...VOICE.yesNo(),
    ];

    assert.ok(every.length >= 10, "the helpers should still be producing buttons");
    for (const b of every) {
      assert.doesNotMatch(b.title, EMOJI, `"${b.title}" should be plain words`);
    }
  });

  it("still fit, which is the other reason to drop the glyph", () => {
    // WhatsApp truncates a reply button past twenty characters, and an emoji
    // costs two of them before the first letter.
    for (const b of [...helpButtons(), ...draftButtons(), ...VOICE.codeButtons()]) {
      assert.ok(b.title.length <= 20, `"${b.title}" is ${b.title.length} characters`);
    }
  });

  it("keep the tick and cross on the account-name check", () => {
    // Passed at the call site rather than defaulted, so this asserts the
    // shape the callers rely on: two buttons, yes first.
    const [yes, no] = VOICE.yesNo("✅ That's me", "❌ Not me");

    assert.equal(yes!.id, "yes");
    assert.equal(no!.id, "no");
    assert.match(yes!.title, EMOJI, "the one place a glyph earns its space");
    assert.match(no!.title, EMOJI);
  });
});
