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
      {
        userId: "user-1",
        bankCode: "058",
        bankName: "GTBank",
        accountNumber: "0123456789",
        accountName: "DANNY CODES LTD",
      },
    ]);
  });

  it("answers the older form in the shape its own CONFIRM declared", async () => {
    /*
     * The form that closed on CONFIRM, before setup moved inside the form. It
     * may still be open on somebody's phone, or still be what Meta has live
     * if the new JSON was refused at publish, and Meta refuses an answer
     * whose keys do not match the screen. Without this, one refused publish
     * breaks setup for everybody.
     */
    const out = (await answer(ask({}), { check: bank({ ok: true, accountName: "A" }), remember, find })) as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(out.data).sort(), [
      "account_line",
      "account_name",
      "account_number",
      "bank",
      "business_name",
      "email",
      "mfb_bank",
    ]);
  });

  it("answers the v2 form, open on phones for a few hours, in its own CONFIRM's shape", async () => {
    const out = (await answer(ask({ form_version: "2" }), { check: bank({ ok: true, accountName: "A" }), remember, find })) as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(out.data).sort(), ["account_line", "account_name", "business_name", "email", "error_messages"]);
  });

  it("gives each screen of the current form exactly the keys it declares", async () => {
    const screens = (FLOWS.find((f) => f.key === "onboarding")!.json as {
      screens: { id: string; data?: Record<string, unknown> }[];
    }).screens;
    const current = { form_version: "3", business_name: undefined, email: undefined, mfb_bank: undefined };
    for (const r of [
      await answer(ask(current), { check: bank({ ok: false, why: "no_such_account" }), remember, find }),
      await answer(ask(current), { check: bank({ ok: true, accountName: "A" }), remember, find }),
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

/*
 * The rest of setup, done inside the form.
 *
 * These steps used to happen in the chat after the form closed: a code
 * emailed and a message saying so, a typed code, the terms as a second form,
 * then the card. From 1 October 2026 every one of those is a billable
 * message. The form now finishes the job and ends on a screen saying so.
 */
describe("finishing setup inside the form", () => {
  const account = { bankCode: "058", bankName: "GTBank", accountNumber: "0123456789", accountName: "DANNY CODES LTD" };
  const recall = async () => account;
  const calls: string[] = [];
  const actions = {
    startOnboarding: async () => (calls.push("start"), { ok: true as const }),
    resendOnboardingCode: async () => (calls.push("resend"), { ok: true as const }),
    finishOnboarding: async (_u: string, _e: string, code: string) =>
      code === "123456" ? (calls.push("finish"), { ok: true as const }) : { ok: false as const, message: "That code is not right. 2 tries left." },
  };
  const onboarding = (screen: string, data: Record<string, unknown>) => ({
    action: "data_exchange",
    screen,
    flow_token: "onboarding:user-1",
    data,
  });
  const screens = (key: string) =>
    (FLOWS.find((f) => f.key === key)!.json as { screens: { id: string; data?: Record<string, unknown> }[] }).screens;
  const declared = (key: string, id: string) => Object.keys(screens(key).find((s) => s.id === id)!.data ?? {}).sort();

  const confirm = {
    business_name: "Danny Codes Ltd",
    email: "Danny@X.ng",
    account_name: "DANNY CODES LTD",
    account_line: "GTBank · 0123456789",
    confirmed: "true",
    agreed: "true",
  };

  it("will not go on until the details are ticked as correct", async () => {
    calls.length = 0;
    const out = (await answer(onboarding("CONFIRM", { ...confirm, confirmed: "false" }), { recall, actions })) as {
      screen: string;
      data: { error_messages: Record<string, string> };
    };
    assert.equal(out.screen, "CONFIRM");
    assert.match(out.data.error_messages.confirmed!, /correct/);
    assert.deepEqual(calls, [], "something was saved before the tick");
  });

  it("will not go on until the terms are agreed", async () => {
    calls.length = 0;
    const out = (await answer(onboarding("CONFIRM", { ...confirm, agreed: "false" }), { recall, actions })) as {
      data: { error_messages: Record<string, string> };
    };
    assert.match(out.data.error_messages.agreed!, /terms/);
    assert.deepEqual(calls, []);
  });

  it("saves, sends the code, and asks for it on the next screen", async () => {
    calls.length = 0;
    const out = (await answer(onboarding("CONFIRM", confirm), { recall, actions })) as {
      screen: string;
      data: Record<string, unknown>;
    };
    assert.equal(out.screen, "CODE");
    assert.deepEqual(calls, ["start"]);
    // Lower-cased, since that is how the code was issued against it.
    assert.equal(out.data.email, "danny@x.ng");
    assert.equal(out.data.masked_email, "d***@x.ng");
  });

  it("says a wrong code under the box and stays on the screen", async () => {
    const out = (await answer(onboarding("CODE", { code: "111111", email: "danny@x.ng" }), { recall, actions })) as {
      screen: string;
      data: { error_messages: { code: string } };
    };
    assert.equal(out.screen, "CODE");
    assert.match(out.data.error_messages.code, /not right/);
  });

  it("sends a new code from a link on the same screen", async () => {
    calls.length = 0;
    const out = (await answer(onboarding("CODE", { resend: "1", email: "danny@x.ng" }), { recall, actions })) as {
      data: { has_notice: boolean; notice: string };
    };
    assert.deepEqual(calls, ["resend"]);
    assert.equal(out.data.has_notice, true);
  });

  it("ends on a screen that says it worked", async () => {
    calls.length = 0;
    const out = (await answer(onboarding("CODE", { code: "123456", email: "danny@x.ng" }), { recall, actions })) as {
      screen: string;
      data: Record<string, string>;
    };
    assert.equal(out.screen, "DONE");
    assert.deepEqual(calls, ["finish"]);
    assert.equal(out.data.account_name, "DANNY CODES LTD");
  });

  it("answers the v2 form in the shapes its own screens declared", async () => {
    /*
     * v2 is no longer what Meta has live, but it may still be open on a phone,
     * and its CONFIRM carried the business and email. Its CODE and DONE are
     * the same as today's, so those are checked against the current form.
     */
    const back = (await answer(onboarding("CONFIRM", { ...confirm, confirmed: "false" }), { recall, actions })) as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(back.data).sort(), ["account_line", "account_name", "business_name", "email", "error_messages"]);

    for (const r of [
      await answer(onboarding("CONFIRM", confirm), { recall, actions }),
      await answer(onboarding("CODE", { code: "123456", email: "d@x.ng" }), { recall, actions }),
    ] as { screen: string; data: Record<string, unknown> }[]) {
      assert.deepEqual(Object.keys(r.data).sort(), declared("onboarding", r.screen), r.screen);
    }
  });
});

describe("changing the bank inside a form", () => {
  const account = { bankCode: "058", bankName: "GTBank", accountNumber: "0123456789", accountName: "DANNY CODES LTD" };
  const effectiveAt = new Date("2026-09-28T13:20:00Z");
  const done: string[] = [];
  const actions = {
    sendChangeCode: async () => ({ ok: true as const, email: "danny@x.ng" }),
    finishChange: async (_u: string, code: string) =>
      code === "123456"
        ? (done.push("scheduled"), { ok: true as const, effectiveAt })
        : { ok: false as const, message: "That code is not right." },
  };
  const change = (screen: string, data: Record<string, unknown>) => ({
    action: "data_exchange",
    screen,
    flow_token: "payout_change:user-1",
    data,
  });
  const screens = (FLOWS.find((f) => f.key === "payout_change")!.json as {
    screens: { id: string; data?: Record<string, unknown> }[];
  }).screens;
  const declared = (id: string) => Object.keys(screens.find((s) => s.id === id)!.data ?? {}).sort();
  const find = async () => ({ code: "058", name: "GTBank" });

  it("checks the new account on the form, keeping the current one on screen", async () => {
    const out = (await answer(
      change("PAYOUT", { current_line: "Access · ····4321", bank: "058", account_number: "01234" }),
      { find },
    )) as { screen: string; data: Record<string, unknown> };
    assert.equal(out.screen, "PAYOUT");
    assert.equal(out.data.current_line, "Access · ····4321");
    assert.deepEqual(Object.keys(out.data).sort(), declared("PAYOUT"));
  });

  it("asks only for the details tick, not the terms, before the code", async () => {
    const out = (await answer(
      change("CONFIRM", { account_name: "DANNY CODES LTD", account_line: "GTBank · 0123456789", confirmed: "true" }),
      { recall: async () => account, actions },
    )) as { screen: string; data: Record<string, unknown> };
    assert.equal(out.screen, "CODE");
  });

  it("schedules the change only for the right code, and says when it takes effect", async () => {
    done.length = 0;
    const wrong = (await answer(change("CODE", { code: "000000", email: "danny@x.ng" }), {
      recall: async () => account,
      actions,
    })) as { screen: string };
    assert.equal(wrong.screen, "CODE");
    assert.deepEqual(done, []);

    const right = (await answer(change("CODE", { code: "123456", email: "danny@x.ng" }), {
      recall: async () => account,
      actions,
    })) as { screen: string; data: Record<string, string> };
    assert.equal(right.screen, "DONE");
    assert.deepEqual(done, ["scheduled"]);
    assert.match(right.data.effective_line!, /current account/);
    // The last four only: this is a confirmation screen, not a statement.
    assert.match(right.data.account_line!, /····6789$/);
    assert.deepEqual(Object.keys(right.data).sort(), declared("DONE"));
  });

  it("gives CONFIRM exactly the keys it declares, with no terms box", async () => {
    const out = (await answer(change("CONFIRM", { confirmed: "false" }), { recall: async () => account, actions })) as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(out.data).sort(), declared("CONFIRM"));
    assert.ok(!declared("CONFIRM").includes("email"), "a bank change carried the setup form's fields");
  });
});

/*
 * Setup in the order a person is ready for it (27 September 2026): the code
 * straight after the email, then the bank, then the confirm screen with the
 * terms. Every payload says form_version "3".
 */
describe("setup, email code first", () => {
  const v3 = (screen: string, data: Record<string, unknown>) => ({
    action: "data_exchange",
    screen,
    flow_token: "onboarding:user-1",
    data: { ...data, form_version: "3" },
  });
  const account = { bankCode: "058", bankName: "GTBank", accountNumber: "0123456789", accountName: "DANNY CODES LTD" };
  const calls: string[] = [];
  const actions = {
    startSetup: async () => (calls.push("start"), { ok: true as const }),
    verifySetupEmail: async (_u: string, _e: string, code: string) =>
      code === "123456" ? (calls.push("verified"), { ok: true as const }) : { ok: false as const, message: "That code is not right." },
    completeSetup: async () => (calls.push("complete"), { ok: true as const }),
  };
  const deps = {
    actions,
    recall: async () => account,
    remember: async () => {},
    find: async (q: string) => (q === "058" ? { code: "058", name: "GTBank" } : q === "50515" ? { code: "50515", name: "Moniepoint MFB" } : null),
    check: (async () => ({ ok: true, accountName: "DANNY CODES LTD" })) as Checked,
  };
  const screens = (FLOWS.find((f) => f.key === "onboarding")!.json as {
    screens: { id: string; data?: Record<string, unknown> }[];
    routing_model: Record<string, string[]>;
  });
  const declared = (id: string) => Object.keys(screens.screens.find((s) => s.id === id)?.data ?? {}).sort();
  type Out = { screen: string; data: Record<string, unknown> };

  it("asks for the code straight after the email", () => {
    assert.deepEqual(screens.routing_model.BUSINESS, ["CODE"]);
    assert.deepEqual(screens.routing_model.CODE, ["PAYOUT"]);
  });

  it("sends the code from the first screen and shows the box for it", async () => {
    calls.length = 0;
    const out = (await answer(v3("BUSINESS", { business_name: "Danny Codes Ltd", email: "Danny@X.ng" }), deps)) as Out;
    assert.equal(out.screen, "CODE");
    assert.deepEqual(calls, ["start"]);
    assert.equal(out.data.email, "danny@x.ng");
    assert.deepEqual(Object.keys(out.data).sort(), declared("CODE"));
  });

  it("says a bad address on the code screen instead of sending anything", async () => {
    calls.length = 0;
    const out = (await answer(v3("BUSINESS", { business_name: "Danny", email: "not-an-email" }), deps)) as Out;
    assert.deepEqual(calls, []);
    assert.match(String((out.data.error_messages as Record<string, string>).code), /email address/);
  });

  it("goes on to the bank once the code is right, and no further when it is wrong", async () => {
    const wrong = (await answer(v3("CODE", { code: "000000", email: "danny@x.ng" }), deps)) as Out;
    assert.equal(wrong.screen, "CODE");
    const right = (await answer(v3("CODE", { code: "123456", email: "danny@x.ng" }), deps)) as Out;
    assert.equal(right.screen, "PAYOUT");
    assert.deepEqual(Object.keys(right.data).sort(), declared("PAYOUT"));
  });

  it("has one bank list and one account box, nothing else to fill in", () => {
    const payout = screens.screens.find((s) => s.id === "PAYOUT") as unknown as {
      layout: { children: { type: string; children?: { type: string; name?: string }[] }[] };
    };
    const form = payout.layout.children.find((c) => c.type === "Form")!;
    const fields = form.children!.filter((c) => c.type !== "Footer").map((c) => c.name);
    assert.deepEqual(fields, ["bank", "account_number"]);
  });

  it("opens the microfinance list only for somebody who picked it", async () => {
    const out = (await answer(v3("PAYOUT", { bank: "mfb", account_number: "0123456789" }), deps)) as Out;
    assert.equal(out.screen, "MFB");
    assert.deepEqual(Object.keys(out.data).sort(), declared("MFB"));

    const checked = (await answer(v3("MFB", { mfb_bank: "50515", account_number: "0123456789" }), deps)) as Out;
    assert.equal(checked.screen, "CONFIRM");
    assert.match(String(checked.data.account_line), /Moniepoint/);
  });

  it("goes straight to the confirm screen for any bank in the main list", async () => {
    const out = (await answer(v3("PAYOUT", { bank: "058", account_number: "0123456789" }), deps)) as Out;
    assert.equal(out.screen, "CONFIRM");
    assert.deepEqual(Object.keys(out.data).sort(), declared("CONFIRM"));
  });

  it("finishes when both boxes are ticked, however WhatsApp spells a tick", async () => {
    /*
     * The bug that made "Continue" do nothing. An OptIn reaches this endpoint
     * as the boolean true; only the string "true" was accepted, so every
     * ticked box read as unticked and the same screen came back.
     */
    for (const yes of [true, "true"]) {
      calls.length = 0;
      const out = (await answer(
        v3("CONFIRM", { account_name: "DANNY CODES LTD", account_line: "GTBank · 0123456789", confirmed: yes, agreed: yes }),
        deps,
      )) as Out;
      assert.equal(out.screen, "DONE", `a tick sent as ${JSON.stringify(yes)} was read as no tick`);
      assert.deepEqual(calls, ["complete"]);
      assert.deepEqual(Object.keys(out.data).sort(), declared("DONE"));
    }
  });

  it("stays put when a box really is not ticked, saving nothing", async () => {
    calls.length = 0;
    const out = (await answer(v3("CONFIRM", { confirmed: true, agreed: false }), deps)) as Out;
    assert.equal(out.screen, "CONFIRM");
    assert.deepEqual(calls, []);
    assert.deepEqual(Object.keys(out.data).sort(), declared("CONFIRM"));
  });
});
