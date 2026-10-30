/**
 * What WhatsApp charged, read from Meta's pricing analytics (30 October 2026).
 *
 * The sync itself talks to Meta and the database; what is worth pinning here
 * is reading Meta's answer, turning it into naira, and asking the right way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseSpend, spendUrl, toKobo } from "./spend.ts";
import { mayUseReminder } from "../jobs/setup-nudges.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// The shape Meta documents for pricing_analytics, with two days of points.
const D1 = Date.UTC(2026, 9, 28) / 1000;
const D2 = Date.UTC(2026, 9, 29) / 1000;
const answer = {
  currency: "USD",
  pricing_analytics: {
    data: [
      {
        data_points: [
          { start: D1, end: D1 + 86400, country: "NG", pricing_type: "REGULAR", pricing_category: "MARKETING", volume: 3, cost: 0.15 },
          { start: D1, end: D1 + 86400, country: "NG", pricing_type: "REGULAR", pricing_category: "UTILITY", volume: 10, cost: 0.07 },
          { start: D2, end: D2 + 86400, country: "NG", pricing_type: "FREE_CUSTOMER_SERVICE", pricing_category: "UTILITY", volume: 4 },
          { start: D2, end: D2 + 86400, country: "NG", pricing_type: "REGULAR", pricing_category: "UTILITY", volume: 2, cost: 0.02 },
          { start: D2, end: D2 + 86400, country: "NG", pricing_type: "REGULAR", pricing_category: "UTILITY", volume: 1, cost: 0.01 },
          { end: D2, volume: 9, cost: 9 },
        ],
      },
    ],
  },
};

describe("reading Meta's answer", () => {
  const { currency, rows } = parseSpend(answer);

  it("knows the account's currency", () => {
    assert.equal(currency, "USD");
  });

  it("puts each point on its UTC day, by category and type", () => {
    assert.deepEqual(
      rows.map((r) => [r.day, r.category, r.type, r.volume]),
      [
        ["2026-10-28", "marketing", "regular", 3],
        ["2026-10-28", "utility", "regular", 10],
        ["2026-10-29", "utility", "free_customer_service", 4],
        ["2026-10-29", "utility", "regular", 3],
      ],
    );
  });

  it("counts a free point as costing nothing, and adds up repeats", () => {
    assert.equal(rows[2]!.cost, 0);
    assert.ok(Math.abs(rows[3]!.cost - 0.03) < 1e-9);
  });

  it("drops a point with no day rather than guessing one", () => {
    assert.equal(rows.length, 4);
  });

  it("copes with nothing at all", () => {
    assert.deepEqual(parseSpend({}), { currency: null, rows: [] });
    assert.deepEqual(parseSpend(null), { currency: null, rows: [] });
  });
});

describe("naira", () => {
  it("is exact for an account billed in naira", () => {
    assert.equal(toKobo(77.5, "NGN", null), 7750);
  });

  it("uses the day's rate for any other currency", () => {
    assert.equal(toKobo(0.15, "USD", 1500), 22500);
  });

  it("is left empty, not made up, when there is no rate", () => {
    assert.equal(toKobo(0.15, "USD", null), null);
    assert.equal(toKobo(0.15, "USD", 0), null);
  });
});

describe("asking Meta", () => {
  it("asks for daily figures by category, type and country, with the currency", () => {
    const u = decodeURIComponent(spendUrl("123", new Date(D1 * 1000), new Date(D2 * 1000)));
    assert.match(u, /\/123\?fields=currency,pricing_analytics\.start\(\d+\)\.end\(\d+\)\.granularity\(DAILY\)/);
    assert.match(u, /dimensions\(\["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"\]\)/);
    assert.match(u, /graph\.facebook\.com\/v(2[3-9]|[3-9]\d)/);
  });

  it("runs with the hourly jobs", () => {
    assert.match(src("../jobs/overdue.ts"), /await syncWhatsAppSpend\(log\)/);
  });
});

describe("the admin reads Meta, not the estimate", () => {
  const sql = src("../db/migrations/0051_whatsapp_spend.sql");

  it("prices each message from Meta's delivery reports", () => {
    assert.match(sql, /CREATE VIEW whatsapp_billing/);
    assert.match(sql, /payload_json -> 'status' -> 'pricing' ->> 'billable'/);
  });

  it("leaves spend empty, not zero, when Meta has reported nothing", () => {
    assert.match(sql, /\(SELECT sum\(cost_kobo\) FROM s\)\s+AS spend_30d_kobo/);
    const code = sql.replace(/--.*$/gm, "");
    assert.doesNotMatch(code, /cost_estimate_kobo/, "the estimate must not feed the admin's spend");
  });

  it("is closed to the public roles", () => {
    assert.match(sql, /REVOKE ALL ON whatsapp_spend, whatsapp_billing, admin_whatsapp FROM anon/);
    assert.match(sql, /ALTER TABLE whatsapp_spend ENABLE ROW LEVEL SECURITY/);
  });
});

describe("the setup reminder only goes as utility", () => {
  it("needs approval and the utility category both", () => {
    assert.equal(mayUseReminder("APPROVED", "UTILITY"), true);
    assert.equal(mayUseReminder("APPROVED", "MARKETING"), false);
    assert.equal(mayUseReminder("PENDING", "UTILITY"), false);
    assert.equal(mayUseReminder("APPROVED", null), false);
  });

  it("is told the category Meta filed each template under", () => {
    assert.match(src("./register-templates.ts"), /\["template_category", categories\]/);
  });
});
