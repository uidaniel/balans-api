/**
 * The link behind "Pay Now".
 *
 * The obvious way to make that button work is to create the Monnify checkout
 * when the offer is shown and put its URL on the button. It does not survive
 * contact with WhatsApp: the message sits in the chat for ever, and a
 * checkout URL does not. Somebody who scrolls back three days later taps a
 * dead link, and the one thing they were trying to do was give us money.
 *
 * So the button points here instead, and the checkout is created when it is
 * pressed. The link is good for as long as the message is, and nobody who
 * only reads the offer costs us a transaction at Monnify.
 *
 * The token is signed rather than stored, because a row would be a row per
 * offer shown and this needs no state. It says which user, and that we wrote
 * it. It is not a secret: the worst anybody can do with somebody else's token
 * is open a page that offers to pay for their subscription.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.ts";

const b64url = (b: Buffer): string => b.toString("base64url");

function sign(payload: string): string {
  // The same key the email codes are signed with. There is no separate secret
  // to lose, and nothing here is worth a second one.
  const key = Buffer.from(env.ENCRYPTION_KEY ?? "", "base64");
  return b64url(createHmac("sha256", key).update(`pro:${payload}`).digest()).slice(0, 27);
}

/** The token that goes in the URL on the button. */
export function proStartToken(userId: string): string {
  const payload = b64url(Buffer.from(userId.replace(/-/g, ""), "hex"));
  return `${payload}.${sign(payload)}`;
}

/**
 * The user a token names, or null.
 *
 * Compared in constant time. A token is not a secret worth much, but a
 * comparison that returns early is a habit worth not having in a file about
 * payments.
 */
export function userForProToken(token: string): string | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;

  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const raw = Buffer.from(payload, "base64url").toString("hex");
  if (raw.length !== 32) return null;

  // Back into the shape Postgres wants.
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** Where the button sends them. */
export const proStartUrl = (userId: string): string =>
  `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pro/start?t=${proStartToken(userId)}`;
