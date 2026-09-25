/**
 * Where a document is opened by the person it was sent to.
 *
 * An invoice is paid, so its link is the payment page: payment.balans.ng/i/…,
 * served by this API, with the Pay button, the transfer panel and the status
 * that polls.
 *
 * A quote is not paid. It is read, and the sender converts it once the client
 * says yes — at which point the invoice it becomes has a payment link of its
 * own. So a quote's link is balans.ng/q/…: the plain address of the product,
 * which the site passes through to this API's `/q/:token`. Sending a client
 * to "payment." to look at a price they have not agreed to yet reads as being
 * asked for money.
 *
 * One function, because this was built by hand in nine places, and a quote
 * link built the old way in any one of them is a quote that says "payment".
 */

import { env } from "../config.ts";

const trim = (url: string): string => url.replace(/\/$/, "");

export function documentLink(type: string, token: string): string {
  return type === "quote" ? `${trim(env.SITE_URL)}/q/${token}` : `${trim(env.PUBLIC_BASE_URL)}/i/${token}`;
}
