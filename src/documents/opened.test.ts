/** Which opens of an invoice count as the client (31 October 2026). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { personOpened } from "./opened.ts";

describe("an open that can be the client", () => {
  it("is a phone's browser", () => {
    assert.ok(personOpened("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"));
    assert.ok(personOpened("Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"));
  });

  it("is never a link preview, a crawler or a mail scanner", () => {
    for (const robot of [
      "WhatsApp/2.24.21.80 A",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "TelegramBot (like TwitterBot)",
      "curl/8.4.0",
      undefined,
    ]) {
      assert.equal(personOpened(robot), false, String(robot));
    }
  });
});
