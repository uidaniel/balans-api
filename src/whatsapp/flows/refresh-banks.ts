/**
 * Writes Paystack's current list of Nigerian banks to paystack-banks.json.
 *
 *   npm run banks     then npm run flows to publish the form with it
 *
 * The setup form's dropdowns are built from that file rather than fetched
 * while the form is built, so the published form is always a list somebody
 * could read in the repository, and a Paystack outage cannot publish a form
 * with no banks in it.
 */

import { writeFileSync } from "node:fs";
import { listBanks } from "../../payments/paystack.ts";

const banks = (await listBanks())
  .map((b) => ({ name: b.name.trim(), code: b.code }))
  .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

if (banks.length < 50) {
  console.error(`Paystack returned ${banks.length} banks. Not overwriting the list with that.`);
  process.exitCode = 1;
} else {
  // One bank a line, so a change in Paystack's list reads as a one-line diff.
  const body = `[\n${banks.map((b) => `  ${JSON.stringify(b)}`).join(",\n")}\n]\n`;
  writeFileSync(new URL("./paystack-banks.json", import.meta.url), body);
  console.log(`${banks.length} banks written. Run npm run flows to publish them.`);
}
