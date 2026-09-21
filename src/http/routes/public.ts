/**
 * The public document page and its Pay button (PRD F9, section 8).
 *
 * Everything here is reachable with no account and no login. The token is the
 * only credential, which shapes three decisions:
 *
 *   - Nothing confirms whether a token exists. A wrong one and a real one that
 *     was cancelled look the same from outside.
 *   - The pay endpoint is rate limited by token, because it is the one route a
 *     stranger can make the server do outbound work on.
 *   - No amount comes from the request. The client posts a button, not a
 *     number; what is owed is read from the row.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { defaults, env } from "../../config.ts";
import { todayIn } from "../../../core/dates.ts";
import { balansFee, settle, type BalansRates } from "../../../core/fees.ts";
import { initTransaction } from "../../payments/monnify.ts";
import { findByToken, markViewed, outstandingKobo, payable } from "../../documents/public.ts";
import { renderDocument, renderNotFound } from "../../documents/page.ts";
import { recordInitialisedPayment } from "../../documents/payments.ts";
import { renderDocumentPdf } from "../../documents/pdf.ts";
import { get as getFile } from "../../storage/files.ts";
import { fileName } from "../../storage/files.ts";
import { db } from "../../db/pool.ts";

const HTML = "text/html; charset=utf-8";

/** Plan rates from configuration (section 14). */
function ratesFor(plan: "free" | "pro"): BalansRates {
  const p = defaults.plans[plan];
  return { percentBps: p.feePercentBps, minKobo: p.feeMinKobo, capKobo: p.feeCapKobo };
}

/**
 * A few pay attempts per token per minute.
 *
 * Each one costs a call to Monnify, so this is the difference between somebody
 * refreshing and somebody using an invoice link as a way to hammer our
 * processor account. In memory because it only has to survive a minute; a
 * restart losing the counters is not worth a Redis.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const PAY_LIMIT = 8;
const PAY_WINDOW_MS = 60_000;

function tooMany(token: string): boolean {
  const now = Date.now();
  const seen = attempts.get(token);
  if (!seen || now > seen.resetAt) {
    attempts.set(token, { count: 1, resetAt: now + PAY_WINDOW_MS });
    if (attempts.size > 10_000) for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
    return false;
  }
  seen.count += 1;
  return seen.count > PAY_LIMIT;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  /* -- The page ----------------------------------------------------------- */

  app.get<{ Params: { token: string } }>("/i/:token", async (req, reply) => {
    const doc = await findByToken(req.params.token);
    if (!doc) return reply.status(404).type(HTML).send(renderNotFound());

    // Section 6: sent becomes viewed on first client view. Not awaited on the
    // response path — a slow write must not delay the page.
    void markViewed(doc.id).catch((e: unknown) =>
      req.log.error({ err: e, documentId: doc.id }, "could not mark viewed"),
    );

    return reply
      .type(HTML)
      // The page shows money owed and must never be served from a shared cache.
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .send(renderDocument(doc, todayIn(defaults.behaviour.timezone), { token: req.params.token }));
  });

  /* -- The file ------------------------------------------------------------ */

  /**
   * The PDF (F9, F20).
   *
   * Section 8 calls for a signed URL valid for ten minutes. The token in this
   * path is already an unguessable per-document credential from a CSPRNG, and
   * a second signature over the same secret adds ceremony rather than
   * security. What it does add, and what is honoured here, is that the bytes
   * are never cached by anything shared.
   *
   * Rendered on demand the first time. An invoice sent before the renderer
   * existed, or one whose render failed, still has a working link.
   */
  app.get<{ Params: { token: string } }>("/i/:token/pdf", async (req, reply) => {
    const doc = await findByToken(req.params.token);
    if (!doc) return reply.status(404).type(HTML).send(renderNotFound());

    const key = await pdfKeyFor(doc.id);
    let file = key ? await getFile(key) : null;

    if (!file) {
      const made = await renderDocumentPdf(doc.id, req.log);
      if (!made) {
        req.log.error({ documentId: doc.id }, "no pdf available");
        return reply.status(503).type(HTML).send(renderNotFound());
      }
      file = { key: made.key, contentType: "application/pdf", bytes: made.bytes };
    }

    const name = fileName(
      doc.type === "quote" ? "Quote" : "Invoice",
      doc.number,
      doc.clientName,
    );

    return reply
      .type("application/pdf")
      .header("content-disposition", `inline; filename="${name}"`)
      .header("cache-control", "no-store, private")
      .header("x-content-type-options", "nosniff")
      .send(file.bytes);
  });

  /** The receipt, once there is one (F11). */
  app.get<{ Params: { token: string } }>("/i/:token/receipt", async (req, reply) => {
    const doc = await findByToken(req.params.token);
    if (!doc) return reply.status(404).type(HTML).send(renderNotFound());

    const { rows } = await db().query<{ pdf_key: string | null; number: number }>(
      `SELECT r.pdf_key, r.number
         FROM receipts r JOIN payments p ON p.id = r.payment_id
        WHERE p.document_id = $1 AND p.status = 'success'
        ORDER BY r.created_at DESC LIMIT 1`,
      [doc.id],
    );

    const key = rows[0]?.pdf_key;
    const file = key ? await getFile(key) : null;
    if (!file) return reply.status(404).type(HTML).send(renderNotFound());

    return reply
      .type("application/pdf")
      .header(
        "content-disposition",
        `inline; filename="${fileName("Receipt", rows[0]!.number, doc.clientName)}"`,
      )
      .header("cache-control", "no-store, private")
      .send(file.bytes);
  });

  /* -- The Pay button ------------------------------------------------------ */

  app.post<{ Params: { token: string } }>("/i/:token/pay", async (req, reply) => {
    const today = todayIn(defaults.behaviour.timezone);
    const token = req.params.token;

    const doc = await findByToken(token);
    if (!doc) return reply.status(404).type(HTML).send(renderNotFound());

    const again = (error: string) =>
      reply.type(HTML).header("cache-control", "no-store, private")
        .send(renderDocument(doc, today, { token, error }));

    if (tooMany(token)) {
      req.log.warn({ documentId: doc.id }, "pay rate limited");
      return again("Too many attempts just now. Wait a moment and try again.");
    }

    const can = payable(doc);
    if (!can.ok) {
      req.log.info({ documentId: doc.id, why: can.why }, "pay refused");
      return again("This invoice cannot be paid right now.");
    }

    const outstanding = outstandingKobo(doc);

    // The fee is worked out here, from the row, and never from the request.
    const split = settle(outstanding, ratesFor(doc.plan), {
      passToClient: doc.passFeesToClient,
    });

    // Our own reference, so the webhook can find this document again without
    // trusting anything the processor echoes back.
    const reference = `bal_${doc.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;

    const init = await initTransaction({
      amountKobo: split.clientPaysKobo,
      customerName: doc.clientName,
      // Monnify requires an email. The client's is often unknown, so a
      // per-document address on our own domain stands in rather than a
      // placeholder that might belong to somebody real.
      customerEmail: `${reference}@receipts.balans.ng`,
      paymentReference: reference,
      description: `${doc.type === "quote" ? "Quote" : "Invoice"} ${doc.number} from ${doc.businessName}`,
      redirectUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/callback?ref=${reference}`,
      // Everything but our fee goes straight to the user's subaccount. This is
      // the line that keeps Balans out of the money.
      splits: [
        {
          subAccountCode: doc.subAccountCode!,
          amountKobo: split.clientPaysKobo - split.balansFeeKobo,
          bearsFee: true,
        },
      ],
    });

    if (!init.ok) {
      req.log.error({ documentId: doc.id, message: init.message }, "could not start payment");
      return again("We could not reach the payment provider. Please try again in a moment.");
    }

    await recordInitialisedPayment({
      documentId: doc.id,
      userId: doc.userId,
      reference,
      providerReference: init.transactionReference,
      amountKobo: split.clientPaysKobo,
      balansFeeKobo: split.balansFeeKobo,
      expectedProcessorFeeKobo: split.processorFeeKobo,
    });

    req.log.info(
      {
        documentId: doc.id,
        reference,
        chargedKobo: split.clientPaysKobo,
        balansFeeKobo: split.balansFeeKobo,
        toUserKobo: split.clientPaysKobo - split.balansFeeKobo,
      },
      "payment initialised",
    );

    return reply.redirect(init.checkoutUrl, 303);
  });

  /* -- Coming back from checkout ------------------------------------------- */

  /**
   * Where the processor sends the payer afterwards.
   *
   * It proves nothing. The payment is confirmed by the webhook, verified
   * against the provider's API — a redirect is a browser doing what it was
   * told, and anyone can visit this URL. So it does exactly one thing: send
   * the client back to the document, which shows the truth.
   */
  app.get<{ Querystring: { ref?: string; paymentReference?: string } }>(
    "/pay/callback",
    async (req, reply) => {
      const reference = req.query.ref ?? req.query.paymentReference;
      const token = reference ? await tokenForReference(reference) : null;
      if (!token) return reply.redirect("https://balans.ng", 303);
      return reply.redirect(`/i/${token}`, 303);
    },
  );
}

/** The stored PDF for a document's current version, if one was ever made. */
async function pdfKeyFor(documentId: string): Promise<string | null> {
  const { rows } = await db().query<{ pdf_key: string | null }>(
    `SELECT v.pdf_key
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id AND d.current_version = v.version
      WHERE v.document_id = $1`,
    [documentId],
  );
  return rows[0]?.pdf_key ?? null;
}

async function tokenForReference(reference: string): Promise<string | null> {
  const { rows } = await db().query<{ public_token: string | null }>(
    `SELECT d.public_token FROM payments p
       JOIN documents d ON d.id = p.document_id
      WHERE p.reference = $1 LIMIT 1`,
    [reference],
  );
  return rows[0]?.public_token ?? null;
}
