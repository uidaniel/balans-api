/**
 * Which bank, and whose account: one place to ask both.
 *
 * Paystack's list since 26 September 2026. It used to be Monnify's, back when
 * every naira payment settled through a Monnify subaccount and the bank had to
 * be one Monnify could pay out to — which is why wallets like OPay, PalmPay
 * and Moniepoint were turned away. Naira invoices now carry the user's own
 * account for the client to transfer into, so any account a Nigerian bank app
 * can send to is a good one, and the list is simply the banks.
 *
 * The code stored for an account is Paystack's. For licensed banks it is the
 * CBN code, the same everywhere; for wallets and microfinance banks it is
 * Paystack's own, which is what the Paystack subaccount for card payments
 * needs anyway.
 */

import { cachedBanks, resolveAccountNumber, type AccountCheck, type PaystackBank } from "./paystack.ts";
import { matchBank } from "./bank-match.ts";

export type { PaystackBank as DirectoryBank };

/**
 * The bank somebody means.
 *
 * The form sends a code, which is exact. A typed answer sends words ("gtb",
 * "my bank is zenith"), which go through the same alias-aware matcher the
 * typed path has always used, now over Paystack's names.
 */
export async function findBank(query: string): Promise<PaystackBank | null> {
  const q = query.trim();
  if (!q) return null;
  const banks = await cachedBanks();
  return banks.find((b) => b.code === q) ?? matchBank(q, banks);
}

/**
 * Whose account this is, by the bank's own records.
 *
 * Paystack's answer, alone. Monnify used to be asked when Paystack could not
 * answer; it was retired on 3 October 2026, and a second opinion from a
 * sandbox was no opinion at all.
 */
export async function checkAccount(accountNumber: string, bank: PaystackBank): Promise<AccountCheck> {
  return resolveAccountNumber(accountNumber, bank.code);
}
