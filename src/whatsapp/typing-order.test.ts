/**
 * The typing bubble arriving after the answer it was meant to precede.
 *
 * Reported from a real phone: "sometimes I receive the reply before I even
 * see the typing stuff, and it keeps showing typing for some seconds after
 * the message has already sent."
 *
 * Both halves are the same bug. The bubble is started when a message arrives
 * and deliberately not waited on, so the thinking can begin — fine while
 * thinking took a while, wrong the moment it did not. A fast turn sent the
 * reply before Meta had processed the read receipt, so the bubble appeared
 * after the answer. And what clears a bubble is the next message, which had
 * already gone, so it sat there until Meta's own twenty-five second timeout.
 *
 * Nothing failed, nothing was logged, and every test passed: the two calls
 * were correct and unordered. Ordering is the thing to assert.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

process.env.WA_PHONE_NUMBER_ID ??= "1";
process.env.WA_ACCESS_TOKEN ??= "t";

const { markRead, sendText } = await import("./client.ts");

const PHONE = "2349052995617";

/** A Graph transport that records the order of calls and can be held open. */
function transport() {
  const started: string[] = [];
  const finished: string[] = [];
  const gates = new Map<string, () => void>();

  const impl = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { status?: string; type?: string };
    const kind = body.status === "read" ? "receipt" : (body.type ?? "message");
    started.push(kind);

    await new Promise<void>((resolve) => {
      gates.set(kind, resolve);
    });

    finished.push(kind);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: `wamid.${kind}` }] }),
    };
  }) as unknown as typeof fetch;

  return {
    impl,
    started,
    finished,
    /** Let one in-flight call return. */
    release: (kind: string) => {
      const go = gates.get(kind);
      assert.ok(go, `nothing is waiting to be a ${kind}`);
      gates.delete(kind);
      go();
    },
    waiting: (kind: string) => gates.has(kind),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("the typing bubble and the reply it belongs to", () => {
  let t: ReturnType<typeof transport>;

  beforeEach(() => {
    t = transport();
  });

  it("does not let the reply overtake the bubble", async () => {
    /*
     * The bug, in one test. The receipt is still in flight; a reply started
     * now must not reach Meta first, because a bubble that arrives after the
     * answer has nothing left to clear it.
     */
    const read = markRead("wamid.in", { typing: true, to: PHONE, fetchImpl: t.impl });
    await tick();
    assert.deepEqual(t.started, ["receipt"]);

    const said = sendText(PHONE, "Here is your invoice.", { fetchImpl: t.impl });
    await tick();

    assert.deepEqual(t.started, ["receipt"], "the reply went out while the bubble was in the air");

    t.release("receipt");
    await read;
    await tick();

    assert.deepEqual(t.started, ["receipt", "text"], "and it goes as soon as the bubble lands");
    t.release("text");
    await said;
    assert.deepEqual(t.finished, ["receipt", "text"]);
  });

  it("costs nothing once the bubble has landed", async () => {
    // The ordinary case: thinking took longer than a read receipt, so there
    // is nothing left to wait for and the reply goes straight out.
    const read = markRead("wamid.in", { typing: true, to: PHONE, fetchImpl: t.impl });
    await tick();
    t.release("receipt");
    await read;

    const said = sendText(PHONE, "Here is your invoice.", { fetchImpl: t.impl });
    await tick();
    assert.ok(t.waiting("text"), "the reply should already be at Meta");
    t.release("text");
    await said;
  });

  it("does not hold a reply when the receipt fails", async () => {
    // A read receipt is cosmetic and never retried. It must not become a
    // thing that can stop somebody's invoice going out.
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;

    await markRead("wamid.in", { typing: true, to: PHONE, fetchImpl: failing });

    const said = sendText(PHONE, "Here is your invoice.", { fetchImpl: t.impl });
    await tick();
    assert.ok(t.waiting("text"), "a failed receipt blocked the reply");
    t.release("text");
    await said;
  });

  it("does not make one person's bubble hold up another person's message", async () => {
    // A single global would couple every conversation on the server to
    // whichever read receipt happened to be slowest.
    const read = markRead("wamid.in", { typing: true, to: PHONE, fetchImpl: t.impl });
    await tick();

    const other = sendText("2348031234567", "Different conversation.", { fetchImpl: t.impl });
    await tick();
    assert.ok(t.waiting("text"), "somebody else's receipt held this message");

    t.release("text");
    await other;
    t.release("receipt");
    await read;
  });

  it("waits on the bubble for the person it belongs to, however their number is written", async () => {
    // markRead is given the number as it arrived on the webhook and sendText
    // is given whatever the caller had. Both are normalised, or the map is
    // keyed two different ways and the gate never closes.
    const read = markRead("wamid.in", { typing: true, to: "0905 299 5617", fetchImpl: t.impl });
    await tick();

    const said = sendText("2349052995617", "Here is your invoice.", { fetchImpl: t.impl });
    await tick();
    assert.equal(t.waiting("text"), false, "the same person, keyed two ways");

    t.release("receipt");
    await read;
    await tick();
    t.release("text");
    await said;
  });

  it("does not wait when no bubble was asked for", async () => {
    // markRead without `typing` is just a blue tick, and there is no bubble
    // whose order could be wrong.
    const read = markRead("wamid.in", { to: PHONE, fetchImpl: t.impl });
    await tick();

    const said = sendText(PHONE, "Here is your invoice.", { fetchImpl: t.impl });
    await tick();
    assert.ok(t.waiting("text"));

    t.release("text");
    await said;
    t.release("receipt");
    await read;
  });
});
