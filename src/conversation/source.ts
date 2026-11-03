/**
 * Where a sign-up came from (3 November 2026), recorded once, for the admin
 * panel. See migration 0060.
 */

import { db } from "../db/pool.ts";
import type { Inbound } from "../whatsapp/inbound.ts";

export type Source = { source: "ad" | "post" | "website" | "waitlist" | "direct"; detail: string | null; adId: string | null };

/** "Hi Balans" from the website, with the ?ref it was opened with. See chat-link.tsx. */
const WEBSITE = /^hi balans(?:\s*\(ref:\s*([A-Za-z0-9_-]{2,32})\))?[\s.!👋]*$/i;

/** What the first message says about where it came from. */
export function sourceOf(msg: Pick<Inbound, "text" | "referral">): Source {
  const r = msg.referral;
  if (r) {
    return {
      source: r.sourceType === "post" ? "post" : "ad",
      detail: (r.headline || r.body || r.sourceUrl || "").trim().slice(0, 200) || null,
      adId: r.sourceId ?? null,
    };
  }
  const site = WEBSITE.exec((msg.text ?? "").trim());
  // The launch message's button opens the chat through balans.ng/start with "(ref: launch)".
  if (site && site[1]?.toLowerCase() === "launch") return { source: "waitlist", detail: null, adId: null };
  if (site) return { source: "website", detail: site[1] ?? null, adId: null };
  return { source: "direct", detail: null, adId: null };
}

/** Recorded only if nothing is yet: the first channel is the one. Never throws. */
export async function recordSource(userId: string, s: { source: string; detail: string | null; adId: string | null }): Promise<void> {
  await db()
    .query(
      `UPDATE users SET signup_source = $2, signup_detail = $3, signup_ad_id = $4
        WHERE id = $1 AND signup_source IS NULL`,
      [userId, s.source, s.detail, s.adId],
    )
    .catch(() => {});
}
