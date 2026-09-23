/**
 * Our own WhatsApp number, asked of Meta rather than configured.
 *
 * There is no env var for it and there should not be: the number is a
 * property of the phone number id we already hold, and a second copy is a
 * second thing to get wrong when the number changes. Meta will say what it
 * is, and it does not change between restarts, so it is asked once.
 *
 * It is wanted for exactly one thing — a `wa.me` link that sends somebody
 * back to their chat after paying. That link is served to a person who is in
 * that chat already, from the payments host, and never rendered into the
 * marketing site.
 */

import { env } from "../config.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

let cached: string | null = null;
let asked = false;

/**
 * Digits only, no plus, the shape `wa.me` wants.
 *
 * Null when it cannot be had. Every caller has to cope with that anyway —
 * this is a convenience on a page, not a step in a payment — so a failure
 * here must never be the reason something else stops.
 */
export async function displayNumber(): Promise<string | null> {
  if (cached || asked) return cached;
  asked = true;

  if (!env.WA_PHONE_NUMBER_ID || !env.WA_ACCESS_TOKEN) return null;

  try {
    const res = await fetch(`${GRAPH}/${env.WA_PHONE_NUMBER_ID}?fields=display_phone_number`, {
      headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { display_phone_number?: string };
    const digits = (body.display_phone_number ?? "").replace(/\D/g, "");
    cached = digits.length >= 10 ? digits : null;
    return cached;
  } catch {
    // The number is a nicety. Nothing here is worth an exception escaping to.
    return null;
  }
}

/** Lets a test start again. Not used in the running product. */
export function _forgetNumber(): void {
  cached = null;
  asked = false;
}
