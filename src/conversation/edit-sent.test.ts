/**
 * Changing an invoice after it was sent (9 October 2026): "Change it" under a
 * sent invoice, or "edit invoice 3", opens it in the form; sending the draft
 * updates the same invoice, same number and link, and counts as one more.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { asCommand } from "../parser/commands.ts";

describe("changing a sent invoice", () => {
  it("reads 'edit invoice 3' and its cousins", () => {
    for (const t of ["edit invoice 3", "change invoice 3", "update invoice #3", "fix inv 3"]) {
      assert.deepEqual(asCommand(t), { intent: "edit_document", documentNumber: 3 }, t);
    }
  });

  it("starting a new invoice forgets the one being changed", () => {
    const machine = readFileSync(new URL("./machine.ts", import.meta.url), "utf8");
    assert.match(machine, /editingId: _e, editingNumber: _n/);
    assert.match(machine, /return startDocument\(p, forget\(ctx\), now, msg\.quote, msg\.text\)/);
  });

  it("sends into the same invoice when one is being changed", () => {
    const handle = readFileSync(new URL("./handle.ts", import.meta.url), "utf8");
    assert.match(handle, /ctx\.editingId\s*\? await applyEdit\(userId, draft\.id, ctx\.editingId\)\s*: await confirmDraft\(userId, draft\.id\)/);
  });

  it("counts a change towards the month", () => {
    const queries = readFileSync(new URL("../documents/queries.ts", import.meta.url), "utf8");
    assert.match(queries, /FROM document_edits/);
  });

  it("refuses anything paid or cancelled", () => {
    const store = readFileSync(new URL("../documents/store.ts", import.meta.url), "utf8");
    const fn = store.slice(store.indexOf("export async function applyEdit"));
    assert.match(fn, /status IN \('sent', 'viewed', 'overdue'\) AND amount_paid_kobo = 0/);
  });
});

describe("only the edit form can update an invoice", () => {
  const handle = readFileSync(new URL("./handle.ts", import.meta.url), "utf8");
  it("tags the form it sends with the invoice", () => {
    assert.match(handle, /tokenTail: `edit:\$\{found\.id\}`/);
  });
  it("reads the edit from the form's token, not from what the chat remembers", () => {
    assert.match(handle, /tokenParts\[2\] === "edit"/);
    assert.match(handle, /const editing = editId \? await editTarget\(userId, editId\) : null;/);
    assert.doesNotMatch(handle, /before\.editingId/);
  });
});

describe("the client is told it is an update", () => {
  const email = readFileSync(new URL("../email/client-delivery.ts", import.meta.url), "utf8");
  const wa = readFileSync(new URL("../documents/client-whatsapp.ts", import.meta.url), "utf8");
  const handle = readFileSync(new URL("./handle.ts", import.meta.url), "utf8");
  it("says Updated in the email subject and names the version it replaces", () => {
    assert.match(email, /\(updatedFrom \? "Updated: " : ""\)/);
    assert.match(email, /It replaces the version sent on/);
  });
  it("uses the updated template on WhatsApp once Meta approves it", () => {
    assert.match(wa, /TEMPLATES\.client_invoice_updated\.name/);
  });
  it("passes the edit through from the send step", () => {
    assert.match(handle, /emailDocumentToClient\(confirmed\.id, log, confirmed\.updatedFrom \?\? null\)/);
    assert.match(handle, /Boolean\(confirmed\.updatedFrom\)/);
  });
});
