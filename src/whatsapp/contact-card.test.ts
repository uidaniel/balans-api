/**
 * The "save Balans" contact card sent after setup.
 *
 * Until Meta grants a badge, an unsaved business shows as its number with
 * "~Balans" small underneath. A saved contact shows "Balans". The card is
 * what gets people there in one tap, so its shape is what matters.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.WA_PHONE_NUMBER_ID ??= "1";
process.env.WA_ACCESS_TOKEN ??= "t";

const { sendContactCard } = await import("./client.ts");

function capture() {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("the contact card", () => {
  it("is a contacts message naming Balans, with our number as a WhatsApp number", async () => {
    const { sent, fetchImpl } = capture();
    const res = await sendContactCard(
      "2348107408438",
      { name: "Balans", waNumber: "234 800 000 0001", email: "hello@balans.ng", url: "https://balans.ng" },
      { fetchImpl },
    );
    assert.equal(res.ok, true);
    const body = sent[0] as { type: string; contacts: Record<string, any>[] };
    assert.equal(body.type, "contacts");
    const c = body.contacts[0]!;
    assert.equal(c.name.formatted_name, "Balans");
    // wa_id is what makes the card open a chat rather than a phone call.
    assert.deepEqual(c.phones[0], { phone: "+2348000000001", wa_id: "2348000000001", type: "WORK" });
    assert.equal(c.emails[0].email, "hello@balans.ng");
    assert.equal(c.urls[0].url, "https://balans.ng");
  });

  it("refuses a number it cannot send to, without calling Meta", async () => {
    const { sent, fetchImpl } = capture();
    const res = await sendContactCard("not a number", { name: "Balans", waNumber: "2348000000001" }, { fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(sent.length, 0);
  });
});
