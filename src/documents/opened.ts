/**
 * "Zenith opened invoice 12", told to the sender once (31 October 2026).
 *
 * The templates for it were approved in September and nothing sent them. It
 * is the message that brings somebody back to the chat between sending an
 * invoice and being paid, and the moment to remind them that a transfer into
 * their bank only counts once they mark it.
 *
 * Not every open is the client. Two are filtered out:
 *
 *   - Robots. WhatsApp and Facebook fetch a link to draw its preview, mail
 *     scanners fetch every link in an email, and search engines crawl. Each
 *     says what it is in its user agent.
 *   - The sender checking their own link, which is what an open in the first
 *     two minutes after sending almost always is.
 *
 * Anything else is taken as the client. It cannot be proved, which is why the
 * words inside the window say the invoice was opened rather than who did it.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { send } from "../whatsapp/outbound.ts";
import { b, para } from "../whatsapp/format.ts";

const ROBOT = /bot|crawl|spider|preview|whatsapp|facebookexternalhit|facebot|slack|telegram|discord|twitter|skype|linkedin|google|bing|yahoo|curl|wget|python|node-fetch|axios|go-http|headless|scanner|safelinks|proofpoint|mimecast|barracuda/i;

/** Whether an open with this user agent can be a person. */
export function personOpened(userAgent: string | undefined): boolean {
  return Boolean(userAgent) && !ROBOT.test(userAgent!);
}

export async function tellOpened(documentId: string, userAgent: string | undefined, log: FastifyBaseLogger): Promise<void> {
  if (!personOpened(userAgent)) return;

  // Claimed in the same statement that decides it, so two opens at once
  // cannot both announce it.
  const { rows } = await db().query<{
    user_id: string;
    wa_phone: string;
    type: string;
    number: number | null;
    client_name: string;
    manual: boolean;
  }>(
    `UPDATE documents d
        SET opened_told_at = now()
       FROM users u, clients c
      WHERE d.id = $1
        AND u.id = d.user_id AND c.id = d.client_id
        AND d.opened_told_at IS NULL
        AND d.sent_at < now() - interval '2 minutes'
        AND d.status IN ('sent', 'viewed', 'overdue', 'part_paid')
        AND u.status = 'active'
      RETURNING d.user_id, u.wa_phone, d.type, d.number, c.name AS client_name,
                (d.delivery_type IN ('bank_details', 'own_details') OR d.currency = 'NGN') AS manual`,
    [documentId],
  );
  const r = rows[0];
  if (!r || r.number === null) return;

  const word = r.type === "quote" ? "quote" : r.type === "payment_request" ? "payment request" : "invoice";
  const outcome = await send(
    {
      userId: r.user_id,
      phone: r.wa_phone,
      text: para(
        `👀 ${b(`Your ${word} #${r.number} for ${r.client_name} was just opened.`)}`,
        r.type === "quote"
          ? `Reply ${b(`convert quote ${r.number}`)} when they say yes.`
          : r.manual
            ? "Balans cannot see your bank, so tap below once the money is in your account."
            : "You will hear from me the moment they pay.",
      ),
      ...(r.type !== "quote" && r.manual
        ? { buttons: [{ id: `mark invoice ${r.number} as paid`, title: "Mark as paid" }] }
        : {}),
      // The approved words name an invoice and say it was the client.
      ...(r.type === "invoice"
        ? { fallback: { template: "invoice_viewed_v2" as const, params: [r.client_name, String(r.number)] } }
        : {}),
    },
    log,
  );
  log.info({ documentId, outcome: outcome.kind }, "sender told the document was opened");
}
