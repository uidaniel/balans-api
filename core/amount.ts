// Nigerian shorthand amounts -> integer kobo (PRD F3).
// "350k" = 350,000; "1.2m" = 1,200,000; "5h" = 500; "2.5k" = 2,500;
// "₦350,000", "N350000" and "350000.50" also work. Returns null if unparseable.

const MULT: Record<string, number> = { h: 100, k: 1_000, m: 1_000_000 };

export function parseAmountToKobo(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/^(₦|ngn|n)\s*/, "").replace(/,/g, "").replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?)([hkm])?$/.exec(s);
  if (!m) return null;
  // Both groups are guaranteed by the regex above; group 2 is optional.
  const num = m[1]!;
  const suffix = m[2];
  // Work in integer thousandths to avoid float drift (e.g. 1.2 * 1e6).
  const [whole, frac = ""] = num.split(".") as [string, string?];
  if (frac.length > 6) return null;
  const scale = 10 ** frac.length;
  const units = BigInt(whole + frac); // value * scale
  // The regex only admits h, k or m, so the lookup always hits.
  const nairaTimesScale = units * BigInt(suffix ? MULT[suffix]! : 1);
  const koboTimesScale = nairaTimesScale * BigInt(100);
  if (koboTimesScale % BigInt(scale) !== BigInt(0)) return null; // finer than a kobo
  const kobo = Number(koboTimesScale / BigInt(scale));
  return Number.isSafeInteger(kobo) ? kobo : null;
}
