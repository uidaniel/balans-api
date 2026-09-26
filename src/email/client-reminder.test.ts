import assert from "node:assert/strict";
import { it } from "node:test";

import { reminderEmail } from "./client-reminder.ts";

const base = {
  to: "pay@zenith.example", clientName: "Zenith Homes", business: "Kemi Adeyemi Studio",
  businessEmail: "kemi@example.com", number: 16, owedKobo: 1_250_000_00,
  due: { y: 2026, m: 9, d: 20 }, today: { y: 2026, m: 9, d: 26 },
  link: "https://payment.balans.ng/i/abc",
};

it("reaches the client from the business, with replies going to the business", () => {
  const m = reminderEmail({ ...base, bankTransfer: true });
  assert.equal(m.fromName, "Kemi Adeyemi Studio via Balans");
  assert.equal(m.replyTo, "kemi@example.com");
  assert.match(m.subject, /Reminder: invoice #16 from Kemi Adeyemi Studio — ₦1,250,000/);
});

it("offers the account on a naira invoice and the card on one abroad", () => {
  assert.match(reminderEmail({ ...base, bankTransfer: true }).html, /See how to pay/);
  assert.match(reminderEmail({ ...base, bankTransfer: false }).html, /Pay ₦1,250,000/);
});

it("tells a client who already paid what to do", () => {
  // On a direct transfer nothing tells us it arrived except the sender.
  assert.match(reminderEmail({ ...base, bankTransfer: true }).text, /Already paid\?/);
});
