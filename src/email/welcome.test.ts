/**
 * The welcome email.
 *
 * Whether it is sent once is decided in SQL (see `recordConsent`); what is
 * checked here is what it says, and that the picture it shows is the picture
 * it carries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { welcomeEmail } from "./send.ts";

const base = { businessName: "Kemi Adeyemi Studio", email: "kemi@example.com", waNumber: "2348000000000" };

describe("the welcome email", () => {
  it("attaches the banner it shows", () => {
    const m = welcomeEmail(base);
    assert.equal(m.images?.length, 1);
    assert.match(m.html!, new RegExp(`src="cid:${m.images![0]!.cid}"`));
  });

  it("names the business, and escapes it", () => {
    const m = welcomeEmail({ ...base, businessName: "<b>Kemi</b> & Co" });
    assert.equal(m.subject, "Welcome to Balans, <b>Kemi</b> & Co");
    assert.match(m.html!, /&lt;b&gt;Kemi&lt;\/b&gt; &amp; Co is ready to get paid/);
    assert.doesNotMatch(m.html!, /<b>Kemi<\/b>/);
  });

  it("reads without a business name", () => {
    const m = welcomeEmail({ ...base, businessName: null });
    assert.equal(m.subject, "Welcome to Balans");
    assert.match(m.html!, /You are ready to get paid/);
  });

  it("points back at the chat, and leaves the button out when the number is unknown", () => {
    assert.match(welcomeEmail(base).html!, /href="https:\/\/wa\.me\/2348000000000"/);
    assert.doesNotMatch(welcomeEmail({ ...base, waNumber: null }).html!, /wa\.me/);
  });

  it("says the money is never ours to hold, in both parts", () => {
    const m = welcomeEmail(base);
    assert.match(m.html!, /Balans never holds it/);
    assert.match(m.text, /Balans never holds it/);
  });
});
