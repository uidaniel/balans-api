/**
 * Bank matching, as people actually type it. Moved from the Monnify tests
 * when Monnify was retired; the lists are slices of real bank lists.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchBank } from "./bank-match.ts";

type Bank = { name: string; code: string; nipBankCode: string | null };

describe("bank matching, as people actually type it", () => {
  // A slice of the 374 the sandbox returns, including the confusable ones.
  const banks: Bank[] = [
    { name: "Access bank", code: "044", nipBankCode: "044" },
    { name: "Access bank (Diamond)", code: "063", nipBankCode: "063" },
    { name: "GTBank Plc", code: "058", nipBankCode: "058" },
    { name: "United Bank For Africa", code: "033", nipBankCode: "033" },
    { name: "First Bank of Nigeria", code: "011", nipBankCode: "011" },
    { name: "Zenith bank", code: "057", nipBankCode: "057" },
    { name: "Moniepoint MFB", code: "50515", nipBankCode: "50515" },
    { name: "Kuda Microfinance Bank", code: "50211", nipBankCode: "50211" },
    { name: "Sterling bank", code: "232", nipBankCode: "232" },
  ];

  const cases: [string, string | null][] = [
    ["Access bank", "044"],
    ["access", "044"], // must not pick "(Diamond)"
    ["ACCESS BANK", "044"],
    ["gtbank", "058"],
    ["GTB", "058"],
    ["gt bank", "058"],
    ["guaranty trust", "058"],
    ["uba", "033"],
    ["United Bank For Africa", "033"],
    ["first bank", "011"],
    ["fbn", "011"],
    ["zenith", "057"],
    ["moniepoint", "50515"],
    ["kuda", "50211"],
    ["sterling", "232"],
    ["my bank is Zenith,", "057"], // what the machine hands over verbatim
    ["", null],
    ["not a bank at all", null],
  ];

  for (const [input, code] of cases) {
    it(`${JSON.stringify(input)} -> ${code ?? "no match"}`, () => {
      assert.equal(matchBank(input, banks)?.code ?? null, code);
    });
  }
});


describe("a bank name resolves to a bank that can be paid", () => {
  /**
   * Monnify lists 374 entries, and only 85 have a three-digit CBN code. The
   * rest are NIP-only routes: wallets, agent networks, some microfinance
   * banks. Both kinds resolve an account name perfectly well, which is the
   * trap — a wallet passes every check and then fails at subaccount creation,
   * after the user has confirmed their name and thinks they are finished.
   *
   * Several institutions appear twice, once each way. These are the ones that
   * must land on the bank.
   */
  const LIST: Bank[] = [
    { name: "GTBank", code: "058", nipBankCode: "058" },
    { name: "GT MOBILE", code: "923", nipBankCode: "923" },
    { name: "Access bank", code: "044", nipBankCode: "044" },
    { name: "ACCESS MONEY", code: "927", nipBankCode: "927" },
    { name: "ACCESS YELLO & BETA", code: "100052", nipBankCode: "100052" },
    { name: "Zenith bank", code: "057", nipBankCode: "057" },
    { name: "ZENITH MOBILE", code: "932", nipBankCode: "932" },
    { name: "United Bank For Africa Plc", code: "033", nipBankCode: "033" },
    { name: "First City Monument Bank Plc", code: "214", nipBankCode: "214" },
    { name: "FCMB MOBILE", code: "100031", nipBankCode: "100031" },
    { name: "OPAY 3", code: "999992", nipBankCode: "999992" },
    { name: "PAYCOM (OPAY)", code: "305", nipBankCode: "100004" },
    { name: "Globus", code: "00103", nipBankCode: "00103" },
    { name: "Globus Bank", code: "103", nipBankCode: "103" },
    { name: "Wema bank", code: "035", nipBankCode: "035" },
    { name: "Moniepoint Microfinance Bank", code: "50515", nipBankCode: "50515" },
  ];

  const cases: [string, string][] = [
    ["gtbank", "058"],
    ["gtb", "058"],
    ["guaranty trust", "058"],
    ["access", "044"],
    ["access bank", "044"],
    ["zenith", "057"],
    ["uba", "033"],
    // The abbreviation everybody uses matched only the wallet before.
    ["fcmb", "214"],
    ["first city monument", "214"],
    // Same institution listed twice; only one of them settles.
    ["opay", "305"],
    // An exact name match on a NIP route must not beat the licensed bank.
    ["globus", "103"],
    ["wema", "035"],
    // A bank name inside a sentence, which is how the machine hands it over.
    ["my bank is Zenith,", "057"],
    ["i use gtb", "058"],
  ];

  for (const [query, code] of cases) {
    it(`${JSON.stringify(query)} -> ${code}`, () => {
      assert.equal(matchBank(query, LIST)?.code, code);
    });
  }

  it("still finds a bank that only exists as a NIP route", () => {
    // Preferring licensed banks must not mean refusing the others. Moniepoint
    // has no CBN entry, and plenty of freelancers are paid there.
    assert.equal(matchBank("moniepoint", LIST)?.code, "50515");
  });

  it("returns nothing rather than guessing", () => {
    assert.equal(matchBank("not a bank at all", LIST), null);
    assert.equal(matchBank("", LIST), null);
  });
});

