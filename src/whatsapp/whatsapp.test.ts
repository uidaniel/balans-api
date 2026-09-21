import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.WA_PHONE_NUMBER_ID = "1247987061741015";
process.env.WA_ACCESS_TOKEN = "test-token";

const { parseInbound } = await import("./inbound.ts");
const { normalisePhone, sendText } = await import("./client.ts");

/** Meta's envelope, as it actually arrives. */
const envelope = (value: unknown) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1834007831276676", changes: [{ field: "messages", value }] }],
});

const meta = { phone_number_id: "1247987061741015", display_phone_number: "15551403164" };

describe("inbound: text", () => {
  const { messages } = parseInbound(
    envelope({
      messaging_product: "whatsapp",
      metadata: meta,
      contacts: [{ wa_id: "2348012345678", profile: { name: "Kemi" } }],
      messages: [
        {
          id: "wamid.AAA",
          from: "2348012345678",
          type: "text",
          timestamp: "1750000000",
          text: { body: "Invoice Zenith Homes 350k for duplex 3D render, due Friday" },
        },
      ],
    }),
  );

  it("extracts one message", () => assert.equal(messages.length, 1));
  it("keeps the body", () =>
    assert.match(messages[0]!.text!, /^Invoice Zenith Homes 350k/));
  it("picks up the profile name from the parallel contacts array", () =>
    assert.equal(messages[0]!.profileName, "Kemi"));
  it("converts the timestamp from seconds", () =>
    assert.equal(messages[0]!.sentAt.toISOString(), new Date(1750000000 * 1000).toISOString()));
  it("records which business number it arrived on", () =>
    assert.equal(messages[0]!.phoneNumberId, meta.phone_number_id));
});

describe("inbound: other shapes", () => {
  it("reads a tapped button as its id", () => {
    const { messages } = parseInbound(
      envelope({
        metadata: meta,
        messages: [
          {
            id: "wamid.BBB",
            from: "2348012345678",
            type: "interactive",
            timestamp: "1750000001",
            interactive: { type: "button_reply", button_reply: { id: "confirm_14", title: "Send it" } },
          },
        ],
      }),
    );
    assert.equal(messages[0]!.kind, "interactive");
    assert.equal(messages[0]!.text, "confirm_14");
  });

  it("keeps an image caption, which is usually the instruction", () => {
    const { messages } = parseInbound(
      envelope({
        metadata: meta,
        messages: [
          {
            id: "wamid.CCC",
            from: "2348012345678",
            type: "image",
            timestamp: "1750000002",
            image: { id: "media-1", caption: "use this as my logo" },
          },
        ],
      }),
    );
    assert.equal(messages[0]!.kind, "image");
    assert.equal(messages[0]!.mediaId, "media-1");
    assert.equal(messages[0]!.text, "use this as my logo");
  });

  it("separates delivery statuses from messages", () => {
    const { messages, statuses } = parseInbound(
      envelope({
        metadata: meta,
        statuses: [
          { id: "wamid.DDD", status: "delivered", recipient_id: "2348012345678", timestamp: "1750000003" },
        ],
      }),
    );
    assert.equal(messages.length, 0);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.status, "delivered");
  });

  it("batches several entries at once", () => {
    const { messages } = parseInbound({
      object: "whatsapp_business_account",
      entry: [
        { changes: [{ value: { metadata: meta, messages: [{ id: "a", from: "234801", type: "text", text: { body: "one" } }] } }] },
        { changes: [{ value: { metadata: meta, messages: [{ id: "b", from: "234802", type: "text", text: { body: "two" } }] } }] },
      ],
    });
    assert.deepEqual(messages.map((m) => m.text), ["one", "two"]);
  });
});

describe("inbound: junk cannot throw", () => {
  // The webhook must never 500 on an unexpected shape: Meta would retry it
  // forever, and one malformed payload would become a loop.
  const junk: unknown[] = [
    null,
    undefined,
    {},
    { entry: null },
    { entry: [{}] },
    { entry: [{ changes: [{}] }] },
    { entry: [{ changes: [{ value: { messages: [{}] } }] }] },
    { entry: [{ changes: [{ value: { messages: "not-an-array" } }] }] },
    "a string",
    42,
  ];
  for (const [i, payload] of junk.entries()) {
    it(`survives payload ${i}`, () => {
      const out = parseInbound(payload);
      assert.deepEqual(out.messages, []);
      assert.deepEqual(out.statuses, []);
    });
  }

  it("skips a message with no id rather than inventing one", () => {
    const { messages } = parseInbound(
      envelope({ metadata: meta, messages: [{ from: "2348012345678", type: "text", text: { body: "hi" } }] }),
    );
    assert.equal(messages.length, 0);
  });
});

describe("phone normalisation", () => {
  const cases: [string, string | null][] = [
    ["2348012345678", "2348012345678"],
    ["+234 801 234 5678", "2348012345678"],
    ["08012345678", "2348012345678"], // How Nigerians actually write it.
    ["0801-234-5678", "2348012345678"],
    ["8012345678", "2348012345678"],
    ["", null],
    ["abc", null],
    ["0801234", null], // Too short: better to refuse than send nowhere.
    ["23480123", null],
  ];
  for (const [input, expected] of cases) {
    it(`${input || "(empty)"} -> ${expected}`, () => assert.equal(normalisePhone(input), expected));
  }
});

describe("sendText", () => {
  it("posts the shape the Graph API expects", async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    const fake: typeof fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.SENT" }] }), { status: 200 });
    };

    const res = await sendText("08012345678", "Done. Invoice 14 is ready.", { fetchImpl: fake });
    assert.deepEqual(res, { ok: true, waMessageId: "wamid.SENT" });
    assert.match(captured!.url, /\/1247987061741015\/messages$/);
    assert.equal(captured!.body.to, "2348012345678"); // Normalised, not as given.
    assert.equal(captured!.body.messaging_product, "whatsapp");
    assert.deepEqual(captured!.body.text, { preview_url: false, body: "Done. Invoice 14 is ready." });
  });

  it("reports being outside the 24-hour window as its own outcome", async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), {
        status: 400,
      });
    const res = await sendText("2348012345678", "hi", { fetchImpl: fake });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.outsideWindow, true);
    // Retrying would fail identically; a template is needed instead.
    assert.equal(res.ok === false && res.retryable, false);
  });

  it("retries a 500 and succeeds", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return calls < 2
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 });
    };
    const res = await sendText("2348012345678", "hi", { fetchImpl: fake });
    assert.equal(res.ok, true);
    assert.equal(calls, 2);
  });

  it("gives up after three attempts, still marked retryable", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status: 503 });
    };
    const res = await sendText("2348012345678", "hi", { fetchImpl: fake });
    assert.equal(res.ok, false);
    assert.equal(calls, 3);
    assert.equal(res.ok === false && res.retryable, true);
  });

  it("does not retry a bad token", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 190, message: "Invalid OAuth token" } }), {
        status: 401,
      });
    };
    const res = await sendText("2348012345678", "hi", { fetchImpl: fake });
    assert.equal(res.ok, false);
    assert.equal(calls, 1);
    assert.equal(res.ok === false && res.retryable, false);
  });

  it("refuses an unusable number without calling Meta", async () => {
    let called = false;
    const fake: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const res = await sendText("abc", "hi", { fetchImpl: fake });
    assert.equal(res.ok, false);
    assert.equal(called, false);
  });
});
