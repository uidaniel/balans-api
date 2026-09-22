/**
 * The banks offered in the onboarding Flow's dropdown.
 *
 * Monnify returns 374 institutions. Most are microfinance banks and wallets
 * nobody here has heard of, and a dropdown of 374 is worse than a text box —
 * scrolling to find your bank among eighty near-identical names is not an
 * improvement on typing four letters.
 *
 * So this is the list a Nigerian freelancer actually gets paid into: the
 * commercial banks, then the fintechs that have become normal to be paid
 * through. Ordered by how likely somebody is to want it, not alphabetically,
 * because the first five cover most people and a dropdown is read top-down.
 *
 * The values are display names, not codes. They are matched back to a live
 * Monnify code by `matchBank`, which already knows the aliases — so a bank
 * changing its registered name does not silently break a code pinned here,
 * and this list never has to be kept in step with Monnify's.
 *
 * "Other" exists because this list will always be missing somebody. Choosing
 * it drops them into the same typed question onboarding has always asked.
 */

export const OTHER_BANK = "Other";

export const FLOW_BANKS: readonly string[] = [
  // The big commercial banks, in rough order of how many people use them.
  "Access bank",
  "GTBank",
  "Zenith bank",
  "First bank",
  "UBA",
  "Opay",
  "Moniepoint",
  "Palmpay",
  "Kuda",
  "Fidelity bank",
  "Union bank",
  "Sterling bank",
  "Wema bank",
  "Stanbic IBTC",
  "FCMB",
  "Ecobank",
  "Polaris bank",
  "Keystone bank",
  "Unity bank",
  "Heritage bank",
  "Providus bank",
  "Titan Trust bank",
  "Globus bank",
  "Premium Trust bank",
  "SunTrust bank",
  "Jaiz bank",
  "Lotus bank",
  "Parallex bank",
  "Optimus bank",
  "Coronation bank",
  "Citibank",
  "Standard Chartered",
  // Fintechs people are genuinely paid into.
  "VFD microfinance bank",
  "Sparkle",
  "Carbon",
  "FairMoney",
  "Rubies bank",
  "Paga",
  OTHER_BANK,
];

/** What the Flow's Dropdown wants: an id and a title for each row. */
export const bankOptions = (): { id: string; title: string }[] =>
  FLOW_BANKS.map((name) => ({ id: name, title: name }));
