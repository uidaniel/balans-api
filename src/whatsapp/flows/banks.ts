/**
 * The banks offered in the onboarding Flow's dropdown.
 *
 * Monnify returns 374 institutions. Most are microfinance banks and wallets
 * nobody here has heard of, and a dropdown of 374 is worse than a text box —
 * scrolling to find your bank among eighty near-identical names is not an
 * improvement on typing four letters.
 *
 * So this is the list a Nigerian freelancer actually gets paid into: the
 * commercial banks, and the fintechs that have become normal to be paid
 * through.
 *
 * Shown alphabetically. It was ordered by popularity once, on the reasoning
 * that the first five cover most people — but that only helps somebody whose
 * bank is in the first five. Everybody else is left scanning an order they
 * cannot predict, and a dropdown of forty is a thing you look your own bank up
 * in, not a thing you read from the top.
 *
 * `bankOptions` does the sorting rather than this list being kept in order by
 * hand, so a bank added anywhere below still appears in the right place.
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
  // Order here does not matter; `bankOptions` sorts. Kept grouped so it is
  // obvious what the list is for when somebody comes to add to it.
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

/**
 * What the Flow's Dropdown wants: an id and a title for each row.
 *
 * Alphabetical, except that "Other" stays at the bottom. Sorted into the O's
 * it reads as a bank called Other sitting between Optimus and Palmpay, and
 * somebody scanning for their own bank would tap it by accident. It is not a
 * bank; it is the way out of the list.
 */
export const bankOptions = (): { id: string; title: string }[] => {
  const named = FLOW_BANKS.filter((name) => name !== OTHER_BANK).sort((a, b) =>
    // Case-insensitive, so "FCMB" and "Fidelity bank" sort against each other
    // on their letters rather than on capitals coming first.
    a.localeCompare(b, "en", { sensitivity: "base" }),
  );

  return [...named, OTHER_BANK].map((name) => ({ id: name, title: name }));
};
