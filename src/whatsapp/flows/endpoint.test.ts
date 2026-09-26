import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

import { ACCOUNT_ERRORS, answer, openEnvelope, sealResponse, type Checked } from "./endpoint.ts";
import { FLOWS } from "./definitions.ts";

/** What Meta does to a request, from the public half. */
function asMeta(publicKey: string, request: unknown) {
  const aesKey = randomBytes(16);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", aesKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(request), "utf8"), c.final(), c.getAuthTag()]);
  return {
    aesKey,
    iv,
    body: {
      encrypted_flow_data: data.toString("base64"),
      encrypted_aes_key: publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        aesKey,
      ).toString("base64"),
      initial_vector: iv.toString("base64"),
    },
  };
}

describe("the flow endpoint's envelope", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = createPrivateKey(privateKey);

  it("reads what Meta sends", () => {
    const sent = asMeta(publicKey, { action: "ping", version: "3.0" });
    const opened = openEnvelope(sent.body, key);
    assert.deepEqual(opened.request, { action: "ping", version: "3.0" });
  });

  it("answers under the same key with the IV flipped, as Meta reads it", () => {
    const sent = asMeta(publicKey, { action: "ping" });
    const opened = openEnvelope(sent.body, key);
    const sealed = Buffer.from(sealResponse({ data: { status: "active" } }, opened.aesKey, opened.iv), "base64");

    const flipped = Buffer.from(sent.iv.map((b) => ~b & 0xff));
    const d = createDecipheriv("aes-128-gcm", sent.aesKey, flipped);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]).toString("utf8");
    assert.deepEqual(JSON.parse(plain), { data: { status: "active" } });
  });

  it("refuses a request that was tampered with", () => {
    const sent = asMeta(publicKey, { action: "ping" });
    const data = Buffer.from(sent.body.encrypted_flow_data, "base64");
    data[0] = data[0]! ^ 1;
    assert.throws(() => openEnvelope({ ...sent.body, encrypted_flow_data: data.toString("base64") }, key));
  });
});

describe("what the setup form is told", () => {
  const ask = (data: Record<string, unknown>) => ({
    action: "data_exchange",
    screen: "PAYOUT",
    flow_token: "onboarding:user-1",
    data: { business_name: "Danny Codes Ltd", email: "d@x.ng", bank: "058", mfb_bank: "", account_number: "0123456789", ...data },
  });
  const remembered: unknown[] = [];
  const remember = async (userId: string, a: unknown) => {
    remembered.push({ userId, ...(a as object) });
  };
  const bank = (r: Awaited<ReturnType<Checked>>): Checked => async () => r;
  const find = async (q: string) => (q === "058" ? { code: "058", name: "GTBank" } : null);

  it("answers Meta's health check", async () => {
    assert.deepEqual(await answer({ action: "ping" }), { data: { status: "active" } });
  });

  it("says a wrong number under the box, on the same screen, keeping what was typed", async () => {
    const out = await answer(ask({}), { check: bank({ ok: false, why: "no_such_account" }), remember, find });
    assert.deepEqual(out, {
      screen: "PAYOUT",
      data: {
        business_name: "Danny Codes Ltd",
        email: "d@x.ng",
        error_messages: { account_number: ACCOUNT_ERRORS.noSuchAccount },
      },
    });
  });

  it("says when the bank did not answer, rather than calling the number wrong", async () => {
    const out = (await answer(ask({}), { check: bank({ ok: false, why: "unreachable" }), remember, find })) as {
      data: { error_messages: { account_number: string } };
    };
    assert.equal(out.data.error_messages.account_number, ACCOUNT_ERRORS.unreachable);
  });

  it("does not ask the bank about a number that is not ten digits", async () => {
    let asked = false;
    const out = (await answer(ask({ account_number: "01234" }), {
      check: async () => ((asked = true), { ok: true, accountName: "X" }),
      remember,
      find,
    })) as { data: { error_messages: { account_number: string } } };
    assert.equal(asked, false);
    assert.equal(out.data.error_messages.account_number, ACCOUNT_ERRORS.length);
  });

  it("asks for the microfinance bank when only 'Microfinance bank (below)' was picked", async () => {
    const out = (await answer(ask({ bank: "mfb" }), { remember, find })) as { data: { error_messages: { account_number: string } } };
    assert.equal(out.data.error_messages.account_number, ACCOUNT_ERRORS.noMfb);
  });

  it("shows the name on the last screen, and keeps it for the chat", async () => {
    remembered.length = 0;
    const out = (await answer(ask({}), { check: bank({ ok: true, accountName: "DANNY CODES LTD" }), remember, find })) as {
      screen: string;
      data: Record<string, string>;
    };
    assert.equal(out.screen, "CONFIRM");
    assert.equal(out.data.account_name, "DANNY CODES LTD");
    assert.match(out.data.account_line!, /· 0123456789$/);
    assert.deepEqual(remembered, [
      { userId: "user-1", bankCode: "058", accountNumber: "0123456789", accountName: "DANNY CODES LTD" },
    ]);
  });

  it("gives each screen exactly the keys it declares", async () => {
    const screens = (FLOWS.find((f) => f.key === "onboarding")!.json as {
      screens: { id: string; data?: Record<string, unknown> }[];
    }).screens;
    for (const r of [
      await answer(ask({}), { check: bank({ ok: false, why: "no_such_account" }), remember, find }),
      await answer(ask({}), { check: bank({ ok: true, accountName: "A" }), remember, find }),
    ] as { screen: string; data: Record<string, unknown> }[]) {
      const screen = screens.find((s) => s.id === r.screen)!;
      assert.deepEqual(Object.keys(r.data).sort(), Object.keys(screen.data ?? {}).sort(), r.screen);
    }
  });

  it("answers nothing for another form's token", async () => {
    const out = await answer({ ...ask({}), flow_token: "invoice:user-1" }, { remember, find });
    assert.deepEqual(out, { data: { acknowledged: true } });
  });
});
