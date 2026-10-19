/**
 * The trial (19 October 2026): the first three sent documents, ever, with
 * every Pro feature; after that a new one needs Pro. The rule lives in SQL
 * (migration 0045) so every query and `planOf` agree; these hold the pieces
 * of it that are written in two places together.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaults } from "../config.ts";
import { proLapsed, proOffer, trialLine, trialSentLine } from "./messages.ts";

const sql = readFileSync(new URL("../db/migrations/0045_lifetime_trial.sql", import.meta.url), "utf8");
const fn = (name: string) => sql.slice(sql.indexOf(`CREATE FUNCTION ${name}`), sql.indexOf("$$;", sql.indexOf(`CREATE FUNCTION ${name}`)));

describe("the trial", () => {
  it("is the same size in the config and the database", () => {
    assert.match(sql, new RegExp(`trial_documents INTEGER NOT NULL DEFAULT ${defaults.plans.free.trialDocuments}\\b`));
  });

  it("starts everybody at none used: documents made before it are not trial documents", () => {
    assert.match(sql, /ADD COLUMN trial BOOLEAN NOT NULL DEFAULT false/);
  });

  it("counts a cancelled document, so cancel-and-resend is not unlimited", () => {
    const used = fn("balans_trial_used");
    assert.match(used, /d\.status <> 'draft'/);
    assert.doesNotMatch(used, /cancelled/);
  });

  it("does not count an invoice made from a quote, or a change", () => {
    const used = fn("balans_trial_used");
    assert.match(used, /d\.parent_id IS NULL/);
    assert.doesNotMatch(used, /document_edits/);
  });

  it("keeps a trial document's treatment for good, and a paid one's while paying", () => {
    assert.match(fn("balans_doc_pro"), /d\.trial OR balans_paid\(u\)/);
  });

  it("is not callable with the public key", () => {
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION[\s\S]*FROM PUBLIC/);
  });

  it("marks a new document as a trial one unless the account is paying", () => {
    const store = readFileSync(new URL("../documents/store.ts", import.meta.url), "utf8");
    assert.match(store, /\(SELECT NOT balans_paid\(u\) FROM users u WHERE u\.id = \$1\)\)/);
  });
});

describe("what it says", () => {
  it("counts down, and says when they are used", () => {
    assert.match(trialLine({ used: 1, allowance: 3 }), /2 of your 3 free documents left/);
    assert.match(trialLine({ used: 3, allowance: 3 }), /used your 3 free documents/);
    assert.match(trialLine({ used: 5, allowance: 3 }), /used your 3 free documents/, "a paid month's documents can push it past");
  });

  it("never speaks of a month's allowance", () => {
    for (const m of [proOffer({ used: 1, allowance: 3 }), proLapsed(), proLapsed(undefined, 2)]) {
      assert.doesNotMatch(m, /a month\b(?!\.)|this month|resets/i, m);
    }
  });

  it("tells somebody who paid before the trial began that they still have theirs", () => {
    assert.match(proLapsed(undefined, 3), /3 free documents left/);
    assert.match(proLapsed(undefined, 0), /New invoices need Pro/);
  });

  it("counts down under each document sent, and says when the last one went", () => {
    assert.match(trialSentLine({ used: 1, allowance: 3 }), /1 of your 3 free documents\. 2 left/);
    assert.match(trialSentLine({ used: 3, allowance: 3 }), /last free document.*upgrade/);
  });
});
