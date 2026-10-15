/**
 * Every query the assistant's lookups send names every parameter it passes.
 *
 * Postgres refuses a parameter a query never mentions, and the totals for
 * "recent" and "paid" passed today's date without using it. That failed the
 * snapshot sent with every question, and the assistant answered "I couldn't
 * reach your invoice records" (14 October 2026). No database is needed to
 * catch it: the driver is replaced, and each query is checked as it is sent.
 */

// A connection string so the pool can be built; nothing ever connects.
process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const sent: { sql: string; params: unknown[] }[] = [];
const ROW = {
  n: "0", total: "0", paid: "0", owed: "0",
  invoiced: "0", documents: "0", outstanding: "0", overdue: "0",
  business_name: "Danny Codes", email: null, email_verified_at: null, plan_expires_at: null,
  logo_url: null, signature_url: null, template_id: null, default_due_days: 7, created_at: new Date(),
  plan: "free", expired: false,
};
mock.method(pg.Pool.prototype, "query", async (sql: string, params: unknown[] = []) => {
  sent.push({ sql, params });
  return { rows: [ROW], rowCount: 1 };
});

const { toolsFor, snapshot } = await import("./tools.ts");
const TODAY = { y: 2026, m: 10, d: 14 };

function unnamed(sql: string, params: unknown[]): number[] {
  const missing: number[] = [];
  for (let i = 1; i <= params.length; i++) {
    if (!new RegExp(`\\$${i}(?!\\d)`).test(sql)) missing.push(i);
  }
  return missing;
}

describe("the assistant's lookups", () => {
  it("name every parameter they pass, in every query", async () => {
    const run = toolsFor("u1", TODAY);
    for (const which of ["owed", "overdue", "paid", "recent", "quotes", "cancelled"]) {
      await run("list_documents", { which });
      await run("list_documents", { which, client: "Edidiong" });
    }
    await run("money_summary", { period: "this month" });
    await run("get_account", {});
    await snapshot("u1", TODAY);

    assert.ok(sent.length > 20);
    for (const q of sent) {
      assert.deepEqual(unnamed(q.sql, q.params), [], `a parameter is never used in:\n${q.sql}`);
    }
  });
});
