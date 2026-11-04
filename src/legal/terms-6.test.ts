/**
 * Terms and privacy 6.0 (published 4 November 2026, in force 4 December
 * 2026): the version switch, the separate yes to processing outside Nigeria,
 * and the notice with its "I accept".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consentVersion, NEXT_CONSENT, nextConsentInForce } from "../config.ts";
import { step } from "../conversation/machine.ts";
import { FLOWS } from "../whatsapp/flows/definitions.ts";
import { TEMPLATES } from "../whatsapp/window.ts";
import { ACCEPT_BUTTON, noticeEmail, noticeText, termsLink } from "./notice.ts";
import { TERMS_LABEL, TERMS_WORDING } from "./consent.ts";

const NOW = { y: 2026, m: 11, d: 4 };
const at = (iso: string) => Date.parse(iso);

describe("which version a person accepts", () => {
  it("is 5.2 until midnight in Lagos on 4 December 2026, then 6.0", () => {
    if (process.env.LEGAL_CONSENT_VERSION) return;
    assert.equal(consentVersion(at("2026-12-03T22:59:00Z")), "5.2");
    assert.equal(consentVersion(at("2026-12-03T23:00:00Z")), NEXT_CONSENT.version);
    assert.ok(!nextConsentInForce(at("2026-11-04T09:00:00+01:00")));
  });
});

describe("the yes to processing outside Nigeria", () => {
  it("is named in the one terms box, everywhere setup ends", () => {
    const json = JSON.stringify(FLOWS.find((f) => f.key === "onboarding")!.json);
    const boxes = json.match(/"name":"agreed","label":"[^"]+","required":true/g) ?? [];
    assert.equal(boxes.length, 3);
    for (const box of boxes) assert.ok(box.includes(TERMS_LABEL));
    assert.match(TERMS_LABEL, /outside Nigeria/);
    assert.ok(TERMS_LABEL.length <= 120);
    // No second box: one tick at the end of setup.
    assert.doesNotMatch(json, /abroad_ok/);
    // Sent with it, so only this wording records the transfer.
    assert.equal((json.match(new RegExp(`"terms_wording":"${TERMS_WORDING}"`, "g")) ?? []).length, 3);
  });
});

describe("the notice of 6.0", () => {
  it("links to the new texts and asks for the yes", () => {
    const text = noticeText();
    assert.match(text, /4 December 2026/);
    assert.ok(text.includes(termsLink()));
    assert.match(text, /\/privacy\?v=6\.0/);
    assert.match(text, /outside Nigeria/);
    assert.equal(ACCEPT_BUTTON.title, "I accept");
  });

  it("goes by email from support@, saying how to accept", () => {
    const mail = noticeEmail("Kemi Studio");
    assert.equal(mail.sender, "support");
    assert.match(mail.text, /reply I ACCEPT to Balans on WhatsApp/);
  });

  it("sends no WhatsApp message of its own, now that the window is billed too", async () => {
    const { NOTICE_ON_WHATSAPP } = await import("./notice.ts");
    assert.equal(NOTICE_ON_WHATSAPP, false);
  });

  it("never goes as a paid template, only inside the free window", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./notice.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /sendTemplate/);
    assert.ok(!("terms_update" in TEMPLATES));
  });

  it("is accepted by the button and by typing it", () => {
    for (const said of ["I accept", "accept new terms", "I ACCEPT"]) {
      assert.deepEqual(step("idle", {}, { text: said, today: NOW } as never, "5.2").effects, [{ type: "accept_terms" }]);
    }
  });
});
