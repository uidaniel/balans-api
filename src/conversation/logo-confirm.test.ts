/**
 * "Is this your logo?"
 *
 * Every picture sent to this number used to be saved as a logo on sight. The
 * reasoning was that the only sensible thing to send an invoicing bot is a
 * logo, and it is wrong: people send screenshots. A bank alert, a chat with a
 * client, an invoice that looks wrong — and each one silently replaced the
 * logo on every invoice they would send afterwards, with a confirmation
 * message that is easy to scroll past.
 *
 * Nothing failed, which is why it needed noticing rather than debugging. The
 * fix is one question, and the tests below are mostly about what the question
 * must not break: the answer has to be free, the picture must not be fetched
 * until it is wanted, and somebody who ignores the question and types an
 * invoice must get the invoice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { step, VOICE, type Context, type State } from "./machine.ts";
import { parseMessage } from "../parser/parse.ts";

const today = { y: 2026, m: 9, d: 23 };
const MEDIA = "wamid.media.123";

/** In the state a picture leaves behind, with that picture waiting. */
async function answering(text: string, ctx: Context = { pendingLogo: MEDIA }) {
  const parsed = await parseMessage(text, { today });
  assert.ok(parsed.ok);
  return step("awaiting_logo_confirm" as State, ctx, { text, today, parsed: parsed.parsed }, "1.0");
}

describe("the question itself", () => {
  it("asks rather than assuming", () => {
    assert.match(VOICE.isThisYourLogo, /Is this your logo\?/);
  });

  it("says what saying yes will do", () => {
    // The consequence is the part worth knowing: it is not this invoice, it
    // is every invoice from now on.
    assert.match(VOICE.isThisYourLogo, /every invoice/);
  });

  it("offers two buttons, and yes is first", () => {
    const buttons = VOICE.logoButtons();
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0]!.id, "yes");
    assert.equal(buttons[1]!.id, "no");
    for (const b of buttons) assert.ok(b.title.length <= 20, `"${b.title}" is too long`);
  });
});

describe("answering it", () => {
  it("saves the picture on yes, and only then", async () => {
    const out = await answering("yes");
    assert.deepEqual(out.effects, [{ type: "save_logo", mediaId: MEDIA }]);
    assert.equal(out.next, "idle");
    assert.equal(out.context.pendingLogo, undefined, "and stops holding it");
  });

  it("takes yes in the words people actually use", async () => {
    // asCommand owns this list, including "na so" and "e correct". The point
    // of reusing it is that a tap and any of these are the same message.
    for (const yes of ["yes", "Yes", "yeah", "ok", "sure", "na so", "correct"]) {
      const out = await answering(yes);
      assert.deepEqual(out.effects, [{ type: "save_logo", mediaId: MEDIA }], `"${yes}" is a yes`);
    }
  });

  it("keeps the invoices unchanged on no", async () => {
    const out = await answering("no");
    assert.deepEqual(out.effects, [], "nothing is saved");
    assert.equal(out.next, "idle");
    assert.equal(out.context.pendingLogo, undefined);
    assert.match(out.replies[0]!, /unchanged/);
  });

  it("does not save anything when the picture has gone missing", async () => {
    // Belt and braces: a "yes" with nothing held must not reach the saver
    // with an empty id.
    const out = await answering("yes", {});
    assert.deepEqual(out.effects, []);
  });
});

describe("ignoring it", () => {
  it("gives somebody their invoice instead of asking again", async () => {
    /*
     * Section 5: "A new command always wins over a pending question, so users
     * are never trapped." Somebody who sends a screenshot and then types an
     * invoice means the invoice. Re-asking about the picture would be the
     * question holding the conversation hostage.
     */
    const out = await answering("Invoice Tunde 20k for logo design");
    assert.equal(out.context.pendingLogo, undefined, "the picture is dropped");
    assert.notDeepEqual(out.effects, [{ type: "save_logo", mediaId: MEDIA }]);
    assert.ok(
      out.next.startsWith("awaiting") || out.effects.length > 0,
      "and the invoice is acted on",
    );
  });

  it("still answers an unrelated question", async () => {
    const out = await answering("who owes me");
    assert.equal(out.context.pendingLogo, undefined);
    assert.ok(out.effects.length > 0, "the question is answered, not deferred");
  });
});

describe("the picture arriving", () => {
  /*
   * The machine is only half of it.
   *
   * An image never reaches the machine — it is handled at the edge, because
   * it arrives unannounced and must not disturb a draft somebody is halfway
   * through confirming. So every test above can pass while the edge still
   * saves the picture on sight, which is the bug. These watch the edge.
   */
  const handle = readFileSync(new URL("./handle.ts", import.meta.url), "utf8");
  const branch = handle.slice(handle.indexOf('msg.kind === "image" && msg.mediaId'));
  const arriving = branch.slice(0, branch.indexOf("\n  }") + 4);

  it("asks instead of saving", () => {
    assert.match(arriving, /isThisYourLogo/, "the question goes out");
    assert.match(arriving, /logoButtons\(\)/, "with the two buttons under it");
    assert.doesNotMatch(arriving, /handleLogo\(/, "and nothing is saved yet");
  });

  it("holds the picture rather than fetching it", () => {
    // A screenshot should cost the question and nothing else. The id stays
    // downloadable long enough to fetch it on the answer instead.
    assert.match(arriving, /pendingLogo: msg\.mediaId/);
    assert.match(arriving, /"awaiting_logo_confirm"/);
  });

  it("keeps the rest of the conversation while it asks", () => {
    // Spreading the saved context, not replacing it: a half-built document
    // must survive somebody sending a screenshot mid-draft.
    assert.match(arriving, /\.\.\.saved\.context/);
  });

  it("saves it only where the confirmed effect is handled", () => {
    assert.match(handle, /case "save_logo":/);
    assert.match(handle, /handleLogo\(userId, effect\.mediaId/);
  });
});

describe("what the answer costs", () => {
  it("is free for yes and no", async () => {
    // These are the two most likely replies by a wide margin, and a model
    // call for "yes" is a round trip and a bill to learn nothing. No fetch is
    // supplied here, so anything reaching a model would fail rather than
    // quietly pass.
    for (const text of ["yes", "no"]) {
      const out = await parseMessage(text, { today });
      assert.ok(out.ok);
      assert.equal(out.parsed.source, "command", `"${text}" should not need a model`);
    }
  });
});
