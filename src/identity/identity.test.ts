/**
 * Identity checks for card payments from abroad (20 October 2026).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { cacLookup, liveness, ninWithSelfie, SELFIE_THRESHOLD } from "./dojah.ts";
import { businessMatchesAccount, personMatchesAccount, samePerson, words } from "./names.ts";
import { identityPage } from "../http/routes/verify.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** A fetch that answers once with this status and body, and keeps what it was sent. */
const answering = (status: number, body: unknown) => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
};

describe("a person and their payout account", () => {
  const daniel = { first: "DANIEL", middle: "INIOBONG", last: "UWAK" };

  it("match in any order, with or without the middle name", () => {
    assert.ok(personMatchesAccount(daniel, "DANIEL INIOBONG UWAK"));
    assert.ok(personMatchesAccount(daniel, "UWAK DANIEL INIOBONG"));
    assert.ok(personMatchesAccount(daniel, "Uwak, Daniel"));
    assert.ok(personMatchesAccount(daniel, "MR DANIEL UWAK"));
  });

  it("do not match a business, or a different person", () => {
    assert.ok(!personMatchesAccount(daniel, "DANNY CODES LTD"));
    assert.ok(!personMatchesAccount(daniel, "DANIEL OKAFOR"));
    assert.ok(!personMatchesAccount(daniel, "INIOBONG UWAK"));
  });

  it("reads names the way both sources spell them", () => {
    assert.deepEqual(words("Adébáyọ̀  O'Neil-Smith"), ["ADEBAYO", "O", "NEIL", "SMITH"]);
  });
});

describe("a business account", () => {
  it("is the business on the register, short or long", () => {
    assert.ok(businessMatchesAccount("DANNY CODES LIMITED", "DANNY CODES LTD"));
    assert.ok(businessMatchesAccount("DANNY CODES TECHNOLOGY LIMITED", "DANNY CODES"));
    assert.ok(businessMatchesAccount("ZENITH & CO VENTURES", "ZENITH VENTURES"));
  });

  it("is not a business that only shares a word", () => {
    assert.ok(!businessMatchesAccount("DANNY CODES LIMITED", "CODES LTD"));
    assert.ok(!businessMatchesAccount("DANNY CODES LIMITED", "PEAK CODES LTD"));
  });

  it("names the person as a director or proprietor, in either order", () => {
    assert.ok(samePerson({ first: "DANIEL", last: "UWAK" }, { first: "Uwak", last: "Daniel", middle: "Iniobong" }));
    assert.ok(!samePerson({ first: "DANIEL", last: "UWAK" }, { first: "Daniel", last: "Okafor" }));
  });
});

describe("Dojah", () => {
  it("is sent the raw key, the AppId, and bare base64", async () => {
    const { fetchImpl, seen } = answering(200, { entity: { liveness: { liveness_check: true, liveness_probability: 98 }, face: { face_detected: true } } });
    const r = await liveness("data:image/jpeg;base64,AAAA", fetchImpl);
    assert.ok(r.ok && r.live);
    const h = seen[0]!.init.headers as Record<string, string>;
    assert.ok(!String(h.Authorization).startsWith("Bearer"));
    assert.ok("AppId" in h);
    assert.equal(JSON.parse(String(seen[0]!.init.body)).image, "AAAA");
  });

  it("refuses two faces, or none, as not live", async () => {
    const two = await liveness("x", answering(200, { entity: { liveness: { liveness_check: true }, face: { face_detected: true, multiface_detected: true } } }).fetchImpl);
    assert.ok(two.ok && !two.live);
  });

  it("reads the NIN record and the selfie match, at a 90% threshold", async () => {
    const { fetchImpl, seen } = answering(200, {
      entity: { firstname: "JOHN", surname: "MUSA", middlename: "", selfie_verification: { match: true, confidence_value: 99.8 }, photo: "huge" },
    });
    const r = await ninWithSelfie("70123456789", "AAAA", fetchImpl);
    assert.ok(r.ok);
    assert.deepEqual(r.record, { first: "JOHN", middle: null, last: "MUSA", match: true, confidence: 99.8 });
    assert.equal(JSON.parse(String(seen[0]!.init.body)).threshold, SELFIE_THRESHOLD);
    assert.equal(SELFIE_THRESHOLD, 90);
  });

  it("reads the directors and proprietors off the CAC record", async () => {
    const r = await cacLookup("1261103", "COMPANY", answering(200, {
      entity: { company_name: "JOHN DOE LIMITED", affiliates: [{ first_name: "JOHN", last_name: "MUSA", affiliate_type: "PROPRIETOR" }] },
    }).fetchImpl);
    assert.ok(r.ok);
    assert.equal(r.record.people[0]!.role, "PROPRIETOR");
  });

  it("says why a call failed", async () => {
    const r = await ninWithSelfie("70123456789", "AAAA", answering(402, { error: "Insufficient wallet balance" }).fetchImpl);
    assert.ok(!r.ok && r.status === 402);
  });
});

describe("what is kept", () => {
  it("never the selfie, and the NIN only encrypted", () => {
    const v = src("./verify.ts");
    assert.match(v, /nin_encrypted = \$3/);
    assert.match(v, /encrypt\(nin\)/);
    assert.doesNotMatch(v, /selfie\b[^\n]*INSERT|INSERT[^\n]*selfie/);
    assert.doesNotMatch(src("./dojah.ts"), /photo:|image: e\./);
  });

  it("allows three paid attempts a day", () => {
    assert.match(src("./verify.ts"), /export const ATTEMPTS_A_DAY = 3;/);
  });
});

describe("the gate", () => {
  it("asks for verification before a card invoice abroad, once the provider is set up", () => {
    const h = src("../conversation/handle.ts");
    assert.match(h, /if \(cardAbroad && identityRequired\(\)\)/);
    assert.match(h, /const capped = cardAbroad && !identityRequired\(\)/);
  });

  it("opens on the step the account is at", () => {
    assert.match(identityPage("person", "DANNY CODES LTD"), /<section id="business">/);
    assert.match(identityPage("none", null), /<section id="person">/);
    assert.match(identityPage("verified", null), /<section id="verified" class="done">/);
  });
});

describe("after verifying", () => {
  it("brings back the invoice that asked for it, as a draft with its buttons, once", () => {
    const h = src("../conversation/handle.ts");
    // Kept when the invoice is stopped for verification…
    assert.match(h, /SET identity_pending_doc = \$2, identity_pending_at = now\(\)/);
    // …taken off as it is read, and only within a day…
    assert.match(h, /UPDATE users u SET identity_pending_doc = NULL, identity_pending_at = NULL/);
    assert.match(h, /identity_pending_at > now\(\) - interval '1 day' AS fresh/);
    // …and run through the same draft step, buttons and card included.
    assert.match(h, /runEffects\(\[\{ type: "save_draft", doc: r\.doc \}\]/);
    assert.match(h, /await reply\(\s*userId,\s*phone,[\s\S]{0,200}outcome\.buttons,\s*outcome\.buttonsImage/);
  });

  it("is what both ways of passing do", () => {
    const v = src("../http/routes/verify.ts");
    assert.equal(v.match(/void afterVerified\(owner, req\.log\)/g)?.length, 2);
  });
});

describe("asking to verify before it is needed (2 November 2026)", async () => {
  const { step } = await import("../conversation/machine.ts");
  const NOW = { y: 2026, m: 11, d: 2 };
  for (const said of ["verify", "Verify me", "verify my identity", "KYC"]) {
    it(`"${said}" starts the check`, () => {
      const out = step("idle", {}, { text: said, today: NOW } as never, "5.0");
      assert.deepEqual(out.effects, [{ type: "start_identity" }]);
    });
  }
  it("leaves an invoice that mentions verification alone", () => {
    const out = step("idle", {}, { text: "Invoice Tunde 20k for verify app design", today: NOW } as never, "5.0");
    assert.ok(!out.effects.some((e) => e.type === "start_identity"));
  });
});

describe("the liveness answer as Dojah sends it now (2 November 2026)", () => {
  const answering = (entity: unknown) =>
    (async () => new Response(JSON.stringify({ entity }), { status: 200 })) as unknown as typeof fetch;

  it("passes a live face", async () => {
    const r = await liveness("x", answering({ liveness: { spoof: false, confidence: 97 }, face: { detected: true, message: "Face detected" } }));
    assert.ok(r.ok && r.live && r.faces === 1 && r.probability === 97);
  });

  it("refuses a photo of a photo", async () => {
    const r = await liveness("x", answering({ liveness: { spoof: true, confidence: 99.9 }, face: { detected: true, message: "Face detected" } }));
    assert.ok(r.ok && !r.live);
  });

  it("refuses no face, and more than one", async () => {
    const none = await liveness("x", answering({ liveness: { spoof: false, confidence: 90 }, face: { detected: false, message: "No face detected" } }));
    const two = await liveness("x", answering({ liveness: { spoof: false, confidence: 90 }, face: { detected: true, message: "Multiple faces detected" } }));
    assert.ok(none.ok && !none.live && none.faces === 0);
    assert.ok(two.ok && !two.live && two.faces === 2);
  });
});
