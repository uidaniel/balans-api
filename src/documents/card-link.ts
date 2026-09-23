/**
 * Giving a drawn card an address, because one WhatsApp message type insists.
 *
 * Every other picture in this product is uploaded to Meta and referred to by
 * id. That is deliberate: these cards are drawn for one person and carry what
 * they are owed and by whom, and an upload has no address for anyone to
 * visit. `/owed` and `/summary` are the exception, and not by choice — their
 * message carries a link button, and a `cta_url` header takes an image only
 * as a URL:
 *
 *     (#131008) Required parameter is missing
 *     details: "header image must contain link."
 *
 * The alternative was two messages, a picture and then a button, which is
 * what this replaced. One message is the right shape — the card, the figures
 * and the way to the detail are one thought — so the card gets an address,
 * built to be worth as little as possible to anyone who finds it:
 *
 *   - 32 random bytes from a CSPRNG, which is not guessed;
 *   - dead within the hour, while Meta fetches it within seconds;
 *   - never cached by anything shared, never indexed, no referrer.
 *
 * The same message already carries a link to the summary page, which shows
 * strictly more than the card does and lives a day. So this is not a new
 * class of exposure — it is a smaller one, for less time.
 */

import { randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import { env } from "../config.ts";
import { putCard } from "../storage/files.ts";

/**
 * Parks a rendered card and returns the URL Meta should fetch it from.
 *
 * Null rather than throwing when the write fails: a card is an addition to a
 * message that says the same thing in words, and losing the picture must
 * never cost the message.
 */
export async function publishCard(
  userId: string,
  png: Buffer,
  log: FastifyBaseLogger,
): Promise<string | null> {
  try {
    const token = randomBytes(32).toString("hex");
    await putCard(token, png, userId);
    return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/c/${token}.png`;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "card could not be parked, sending the words");
    return null;
  }
}
