/**
 * The email shell, and the one thing about it that cannot be checked by eye.
 *
 * Everything else in here is visible the moment you open a test send. Dark
 * mode is not: Gmail rewrites colours after delivery, by rules it does not
 * publish, and no amount of local rendering will show you the result. So the
 * wordmark went out as ink on a background Gmail had darkened, and read as
 * nothing but the green cast in #10231C.
 *
 * Declaring a background beside the colour is the standard mitigation — it
 * gives the client a pair to reason about rather than a colour on its own.
 * It is not a guarantee, which is why the rule is written down here: the next
 * person to tidy these styles will not know it was deliberate, and will not
 * find out from looking at the email.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layout } from "./layout.ts";

const html = layout({
  preheader: "A preview line.",
  heading: "Your spot is saved",
  body: "<p>Body copy.</p>",
});

/** Every inline style on the rendered email, whitespace flattened. */
const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!.replace(/\s+/g, " "));

describe("the email shell", () => {
  it("gives the wordmark a background to be read against", () => {
    const wordmark = styles.filter((s) => /font-size:19px/.test(s));
    assert.equal(wordmark.length, 1, "one wordmark, or this test is looking at the wrong thing");
    assert.match(wordmark[0]!, /background-color:#F6F1E7/, "on cream, declared");
    assert.match(wordmark[0]!, /(?<!-)color:#10231C/, "in ink");
  });

  it("keeps the mark as an attachment, not a hosted image", () => {
    // Gmail and Outlook block remote images on first open. A logo that only
    // appears for people who click "display images" is not a logo.
    assert.match(html, /src="cid:balans-mark"/);
    assert.doesNotMatch(html, /<img[^>]+src="https?:/);
  });

  it("asks the client not to invert it in the first place", () => {
    // Apple Mail honours this. Gmail does not, which is why the wordmark
    // needed the background as well.
    assert.match(html, /name="color-scheme" content="light"/);
  });
});
