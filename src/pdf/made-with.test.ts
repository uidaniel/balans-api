/**
 * "Made with Balans" is a link (3 November 2026): a client who taps it lands
 * in the chat with "(ref: invoice)", and the admin counts who it brings in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { madeWith, madeWithUrl } from "./kit.ts";
import { sourceOf } from "../conversation/source.ts";

describe("Made with Balans", () => {
  it("links to the chat, tagged as from an invoice", () => {
    assert.match(madeWithUrl(), /\/start\?ref=invoice$/);
    const html = madeWith({ showMadeWith: true } as never);
    assert.match(html, /^<a class="made" href="[^"]+\/start\?ref=invoice"/);
    assert.match(html, /Made with Balans<\/a>$/);
  });

  it("is not there on a Pro document", () => {
    assert.equal(madeWith({ showMadeWith: false } as never), "");
  });

  it("is recorded as the sign-up's source by the bot", () => {
    assert.deepEqual(sourceOf({ text: "Hi Balans (ref: invoice)" }), { source: "website", detail: "invoice", adId: null });
  });

  it("is counted by views closed to the public roles", () => {
    for (const f of ["0062_link_clicks.sql", "0063_admin_growth.sql"]) {
      const sql = readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(sql, /\b(DROP|RENAME|ALTER TABLE users)\b/i, `${f} only adds`);
      for (const v of sql.matchAll(/CREATE VIEW (\w+)/g)) {
        assert.match(sql, new RegExp(`REVOKE ALL ON [^;]*\\b${v[1]}\\b[^;]*FROM anon`), `${v[1]} open to anon`);
        assert.match(sql, /security_invoker = true/);
      }
    }
  });
});
