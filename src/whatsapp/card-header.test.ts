/**
 * Where a drawn card is allowed to travel, and where Meta refuses it.
 *
 * `/owed` and `/summary` both drew a card, uploaded it, and sent it as the
 * image header of the message carrying the "View Summary" button. Every part
 * worked except the send. The log said the card was drawn — 38 kilobytes,
 * 1.4 seconds — and then:
 *
 *     (#131008) Required parameter is missing
 *     details: "header image must contain link."
 *
 * Meta takes an image header on a `cta_url` message only as a URL. An
 * uploaded media id is refused, and it takes the whole message with it: the
 * words and the button go too, so somebody asking who owes them money got a
 * plain paragraph and no idea anything was missing.
 *
 * Proved by probing a throwaway send rather than by reading the docs, which
 * describe an image header on this message type without saying how. The same
 * payload with a link is accepted; with an id it is not; and the same id in
 * an ordinary image message is fine.
 *
 * A URL is the thing these cards must not have. They are drawn for one person
 * and carry what they are owed and by whom, so they are uploaded — an upload
 * has no address for anyone to visit. That is why the card is its own message
 * now and the button follows it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

process.env.WA_PHONE_NUMBER_ID ??= "1";
process.env.WA_ACCESS_TOKEN ??= "t";

const { sendCta, sendImage } = await import("./client.ts");

const PHONE = "2349052995617";
const MEDIA_ID = "2994830510867588";
const LINK = "https://balans.ng/brand/paid-tonight.png";

type Payload = {
  type?: string;
  image?: { id?: string; link?: string; caption?: string };
  interactive?: {
    header?: { type: string; image?: { id?: string; link?: string } };
    body?: { text: string };
    action?: { parameters?: { url?: string; display_text?: string } };
  };
};

/** A transport that keeps the payload instead of sending it. */
function captor() {
  const sent: Payload[] = [];
  const impl = (async (_url: string, init: { body?: string }) => {
    sent.push(JSON.parse(String(init.body)) as Payload);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: "wamid.x" }] }),
    };
  }) as unknown as typeof fetch;
  return { impl, sent };
}

describe("a card on a message with a link button", () => {
  it("drops an uploaded id rather than losing the whole message", () => {
    /*
     * The failure this file is named for. Sending the id means Meta refuses
     * everything — and the words are the part that matters, because a picture
     * cannot be searched in a chat, copied, or read aloud.
     */
    const t = captor();
    return sendCta(
      PHONE,
      { body: "You are owed ₦1,250,000.", label: "View Summary", url: "https://x.ng/s/t", headerImage: MEDIA_ID },
      { fetchImpl: t.impl },
    ).then((res) => {
      assert.equal(res.ok, true, "the message must still go");
      const [msg] = t.sent;
      assert.equal(msg?.interactive?.header, undefined, "a media id was put in the header");
      assert.equal(msg?.interactive?.body?.text, "You are owed ₦1,250,000.");
      assert.equal(msg?.interactive?.action?.parameters?.url, "https://x.ng/s/t");
    });
  });

  it("still takes a link, which is what Meta asked for", async () => {
    // Brand artwork is public and the same file every time, so a link is
    // right for it — and it is the only thing this header accepts.
    const t = captor();
    await sendCta(
      PHONE,
      { body: "Go Pro.", label: "Pay", url: "https://x.ng/p", headerImage: LINK },
      { fetchImpl: t.impl },
    );
    assert.deepEqual(t.sent[0]?.interactive?.header, { type: "image", image: { link: LINK } });
  });
});

describe("a card in a message of its own", () => {
  it("goes by uploaded id, which is how it stays private", async () => {
    const t = captor();
    await sendImage(PHONE, MEDIA_ID, "You are owed ₦1,250,000.", { fetchImpl: t.impl });
    assert.equal(t.sent[0]?.type, "image");
    assert.equal(t.sent[0]?.image?.id, MEDIA_ID);
    assert.equal(t.sent[0]?.image?.link, undefined, "a private card must not get an address");
    assert.equal(t.sent[0]?.image?.caption, "You are owed ₦1,250,000.");
  });

  it("still takes a link for the files that have one", async () => {
    const t = captor();
    await sendImage(PHONE, LINK, "Dem don balans you.", { fetchImpl: t.impl });
    assert.equal(t.sent[0]?.image?.link, LINK);
    assert.equal(t.sent[0]?.image?.id, undefined);
  });

  it("refuses an empty one instead of sending a message with no picture", async () => {
    const t = captor();
    const res = await sendImage(PHONE, "", "caption", { fetchImpl: t.impl });
    assert.equal(res.ok, false);
    assert.equal(t.sent.length, 0);
  });
});

describe("the two commands that draw one", () => {
  const source = readFileSync(new URL("../conversation/handle.ts", import.meta.url), "utf8");

  it("sends the card and then the button, and never as a header", () => {
    // Both branches go through the one helper, so there is a single place
    // that knows the rule. A `headerImage` on either would be the bug back.
    const owed = source.slice(source.indexOf('case "show_debtors"'), source.indexOf('case "show_summary"'));
    const summary = source.slice(source.indexOf('case "show_summary"'));

    for (const [name, branch] of [["/owed", owed], ["/summary", summary.slice(0, 2000)]] as const) {
      assert.match(branch, /cardThenLink\(/, `${name} no longer sends the card`);
      assert.ok(!/headerImage/.test(branch), `${name} is putting a card back in the header`);
    }
  });

  it("says the words once, not under a picture of themselves", () => {
    // The caption carries them when there is a card; the button message
    // carries them only when there is not.
    assert.match(source, /body: said \? o\.prompt : o\.words/);
  });

  it("falls back to the words alone when both messages fail", () => {
    // `/owed` answering with nothing at all is worse than answering plainly.
    assert.match(source, /if \(delivered\) break;\s*\}\s*extra\.push\(words\);/);
  });
});
