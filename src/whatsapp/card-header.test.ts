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
 * Every other picture in this product is uploaded for a reason: these are
 * drawn for one person and carry what they are owed and by whom, and an
 * upload has no address for anyone to visit. So the card got the smallest
 * address that will do — 32 random bytes, dead within the hour, never cached
 * and never indexed — rather than the message being split in two.
 *
 * It was split in two for a while: the picture, and then a button underneath
 * saying "See the whole year?" about a card that had just shown the year.
 * Two bubbles for one thought.
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
  const owed = source.slice(source.indexOf('case "show_debtors"'), source.indexOf('case "show_summary"'));
  const after = source.slice(source.indexOf('case "show_summary"'));
  const summary = after.slice(0, after.indexOf('case "remove_logo"'));

  it("sends one message, not a picture and then a button", () => {
    /*
     * It was two for a while, because of the refusal above: the card as its
     * own image, then a second message carrying the link. Two bubbles for
     * one thought, the second of which said nothing the first had not —
     * "See the whole year?" under a card that had just shown the year.
     *
     * One message is right. The card is the header, the figures are the
     * body, the button is underneath, and the card gets a URL of its own to
     * make that possible.
     */
    for (const [name, branch] of [["/owed", owed], ["/summary", summary]] as const) {
      assert.match(branch, /headerImage: card/, `${name} lost its card`);
      assert.equal(
        (branch.match(/await send(Cta|Image|Text)\(/g) ?? []).length,
        1,
        `${name} sends more than one message`,
      );
    }
  });

  it("gives the card an address that is short-lived and unguessable", () => {
    const link = readFileSync(new URL("../documents/card-link.ts", import.meta.url), "utf8");
    // 32 bytes of CSPRNG, which is not guessed, and hex so the route can
    // recognise it without decoding anything.
    assert.match(link, /randomBytes\(32\)\.toString\("hex"\)/);
    assert.match(link, /\/c\/\$\{token\}\.png/);

    const files = readFileSync(new URL("../storage/files.ts", import.meta.url), "utf8");
    // Refused by age in the query, so a row the sweep has not reached is
    // still dead, and swept on the way past so the table does not grow.
    assert.match(files, /created_at > now\(\) - \(\$2 \|\| ' minutes'\)::interval/);
    assert.match(files, /DELETE FROM stored_files\s*\n\s*WHERE key LIKE 'cards\/%'/);
  });

  it("serves it to nobody but the fetcher of that exact address", () => {
    const routes = readFileSync(new URL("../http/routes/public.ts", import.meta.url), "utf8");
    const route = routes.slice(routes.indexOf('app.get<{ Params: { file: string } }>("/c/:file"'));
    const handler = route.slice(0, route.indexOf("/* -- The file"));

    assert.match(handler, /\^\[0-9a-f\]\{64\}\$/, "anything else is not even looked up");
    assert.match(handler, /no-store, private/, "a card must never sit in a shared cache");
    assert.match(handler, /noindex, nofollow/);
    assert.match(handler, /status\(404\)/, "a dead card is a 404, not an explanation");
  });

  it("still says everything in words when the card cannot be drawn", () => {
    // Chrome can fail and the write can fail. The words are the message; the
    // picture is an addition to it.
    for (const [name, branch] of [["/owed", owed], ["/summary", summary]] as const) {
      assert.match(branch, /\.\.\.\(card \? \{ headerImage: card \} : \{\}\)/, `${name} needs its card`);
      assert.match(branch, /body: words/, `${name} stopped saying it in words`);
    }
    assert.match(source, /extra\.push\(words\);/);
  });
});
