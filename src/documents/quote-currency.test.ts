/**
 * A quote priced abroad becomes an invoice priced abroad.
 *
 * `convertQuote` copied the money and left the currency behind, so accepting
 * a £500 quote produced an invoice whose `currency` defaulted to NGN with no
 * FX fields at all. Nothing rejected it, and that is the worst part: the
 * constraint written to catch exactly this —
 * `documents_foreign_locks_its_rate` — only fires when the currency is *not*
 * NGN, so dropping the currency is the one way to satisfy it.
 *
 * What the client then received was an invoice headed ₦963,066.70 for a price
 * they had agreed as £500, with no mention of pounds anywhere on it. And
 * because every surface reads `doc.foreign`, a null one meant the page offered
 * a Nigerian bank transfer instead of a card — which is not a worse way for
 * somebody abroad to pay, it is no way at all.
 *
 * Found by checking the arithmetic on a real £500 quote, which was correct,
 * and then asking what accepting it would produce.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const convert = actions.slice(actions.indexOf("export async function convertQuote"));
const body = convert.slice(0, convert.indexOf("\n/**"));

describe("converting a quote that was priced abroad", () => {
  it("reads the currency and its rate off the quote", () => {
    assert.match(
      body,
      /d\.currency, d\.original_amount_minor, d\.fx_rate, d\.fx_source, d\.fx_fetched_at/,
      "the quote is read without the fields that say what it was priced in",
    );
  });

  it("writes them onto the invoice it makes", () => {
    const insert = body.slice(body.indexOf("INSERT INTO documents"));
    const columns = insert.slice(0, insert.indexOf("RETURNING id"));
    for (const col of [
      "currency",
      "original_amount_minor",
      "fx_rate",
      "fx_source",
      "fx_fetched_at",
    ]) {
      assert.ok(columns.includes(col), `the invoice is built without ${col}`);
    }
    assert.match(body, /quote\.fx_rate,/, "and from the quote rather than from nowhere");
  });

  it("keeps the rate the quote was struck at, rather than today's", () => {
    /*
     * Acceptance criterion 6. A quote is valid for days; re-striking the rate
     * on acceptance would charge a figure the client never agreed to, on a
     * document whose whole purpose is to record what they did agree to.
     */
    assert.ok(
      !/fetchRate|todayRate|rateFor\(/.test(body),
      "conversion is pricing the invoice again instead of copying the agreed rate",
    );
    assert.match(body, /quote\.fx_fetched_at,/, "the original timestamp travels with it");
  });

  it("carries the per-line foreign figures too", () => {
    // Otherwise a £500 invoice itemises in naira underneath a pound headline,
    // which is the same disagreement one level down.
    const lines = body.slice(body.indexOf("INSERT INTO line_items"));
    assert.match(lines, /original_unit_amount_minor, original_amount_minor/);
  });

  it("still copies a naira quote unchanged", () => {
    /*
     * The columns are copied whatever they hold, so naira copies its own
     * nulls. Worth stating because the mirror constraint,
     * `documents_naira_has_no_rate`, rejects a naira invoice that carries a
     * rate — a conversion that invented one would fail outright.
     */
    assert.ok(
      !/currency = 'NGN'|COALESCE\(d\.currency/.test(body),
      "conversion special-cases naira instead of copying what is there",
    );
  });
});
