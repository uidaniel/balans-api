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
import { initBankTransfer, initTransaction } from "../../payments/monnify.ts";
import { findByToken, markViewed, outstandingKobo, payable, payableNowKobo } from "../../documents/public.ts";
import { renderDocument, renderNotFound, type TransferPanel } from "../../documents/page.ts";
import {
  liveTransferFor,
  paymentProgress,
  recordInitialisedPayment,
  recordTransferAccount,
  type LiveTransfer,
} from "../../documents/payments.ts";
import { renderDocumentPdf } from "../../documents/pdf.ts";
import { confirmPayment } from "../../payments/confirm.ts";
import { notifyPaid } from "../../payments/notify.ts";
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


/**
 * A stored transfer, as the page wants it.
 *
 * The expiry is handed over as a duration rather than a timestamp: the client's
 * phone clock is frequently wrong, and a countdown driven by their clock
 * against our timestamp is a countdown that can start already finished.
 */
const panelFor = (t: LiveTransfer): TransferPanel => ({
  bankName: t.bankName,
  accountNumber: t.accountNumber,
  accountName: t.accountName,
  amountKobo: t.amountKobo,
  ussd: t.ussd,
  expiresInMs: Math.max(0, t.expiresAt.getTime() - Date.now()),
});

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

    // If details were already issued and are still good, show those rather
    // than a Pay button. Somebody returning from their banking app is the
    // common case, and they must find the same account they copied.
    const live = payable(doc).ok ? await liveTransferFor(doc.id, payableNowKobo(doc)) : null;

    return reply
      .type(HTML)
      // The page shows money owed and must never be served from a shared cache.
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .send(
        renderDocument(doc, todayIn(defaults.behaviour.timezone), {
          token: req.params.token,
          transfer: live ? panelFor(live) : null,
        }),
      );
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

    // A payment request has no document (F8). The page has never offered this
    // link for one; typing it by hand should not produce a file the rest of
    // the product says does not exist.
    if (doc.type === "payment_request") {
      return reply.status(404).type(HTML).send(renderNotFound());
    }

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

    const showAccount = (t: LiveTransfer) =>
      reply
        .type(HTML)
        .header("cache-control", "no-store, private")
        .header("referrer-policy", "no-referrer")
        .send(renderDocument(doc, today, { token, transfer: panelFor(t) }));

    if (tooMany(token)) {
      req.log.warn({ documentId: doc.id }, "pay rate limited");
      return again("Too many attempts just now. Wait a moment and try again.");
    }

    const can = payable(doc);
    if (!can.ok) {
      req.log.info({ documentId: doc.id, why: can.why }, "pay refused");
      return again("This invoice cannot be paid right now.");
    }

    // F7: the next unpaid part, or the whole balance when there are none.
    const outstanding = payableNowKobo(doc);

    // Pressing Pay twice must not mint a second account. Monnify matches a
    // transfer on the account *and* the amount, so two live accounts for the
    // same balance is a way to lose somebody's money.
    const existing = await liveTransferFor(doc.id, outstanding);
    if (existing) {
      req.log.info({ documentId: doc.id, reference: existing.reference }, "reusing live transfer account");
      return showAccount(existing);
    }

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

    /*
     * The account to pay into, for this transaction.
     *
     * This is the step that replaces the hosted checkout: the client stays on
     * the invoice, reads an account number, and pays from the bank app they
     * already trust. The split set on the transaction above still decides
     * where the money goes, so nothing about rule 1 changes — we simply stop
     * handing the payer to somebody else's page to do it.
     */
    const transfer = await initBankTransfer(init.transactionReference);

    if (!transfer.ok) {
      // The payment row stays: it is initialised, unpaid, and harmless. If a
      // transfer somehow still arrives against it, the webhook will find it.
      req.log.error(
        { documentId: doc.id, reference, message: transfer.message },
        "could not get transfer details",
      );
      return again("We could not get the account details just now. Please try again in a moment.");
    }

    await recordTransferAccount(reference, transfer.account);

    req.log.info(
      {
        documentId: doc.id,
        reference,
        bank: transfer.account.bankName,
        expiresAt: transfer.account.expiresAt,
      },
      "transfer account issued",
    );

    return showAccount({
      reference,
      providerReference: init.transactionReference,
      amountKobo: split.clientPaysKobo,
      bankName: transfer.account.bankName,
      accountNumber: transfer.account.accountNumber,
      accountName: transfer.account.accountName,
      ussd: transfer.account.ussd,
      expiresAt: transfer.account.expiresAt,
    });
  });

  /* -- Has it landed yet? --------------------------------------------------- */

  /**
   * What the waiting page polls.
   *
   * Answers from our own database, which only the verified-webhook path ever
   * writes to. When the webhook is late — and it sometimes is — this asks
   * Monnify directly, but it does so through exactly the same confirmation
   * code the webhook uses, so a payment is still only ever marked paid after a
   * status check against the provider. There is no second way to become paid.
   */
  app.get<{ Params: { token: string } }>("/i/:token/status", async (req, reply) => {
    const doc = await findByToken(req.params.token);
    if (!doc) return reply.status(404).send({ error: "not_found" });

    const progress = await paymentProgress(doc.id);

    if (!progress.paid) {
      for (const p of progress.pending) {
        const outcome = await confirmPayment(
          { paymentReference: p.reference, transactionReference: p.providerReference },
          req.log,
        );
        if (outcome.kind === "confirmed") {
          void notifyPaid(outcome, req.log);
          return reply.header("cache-control", "no-store").send({ paid: true });
        }
      }
    }

    return reply.header("cache-control", "no-store").send({ paid: progress.paid });
  });

  /* -- Coming back from checkout ------------------------------------------- */

  /** The marketing site, which owns every page a payer is sent to. */
  const SITE = env.SITE_URL.replace(/\/$/, "");

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
      if (!reference) return reply.redirect(SITE, 303);

      /*
       * A subscription is not a document, and used to land on the homepage.
       *
       * `tokenForReference` joins payments to documents, so it finds nothing
       * for a Pro payment — there is no invoice, the payer is us. The lookup
       * returned null and the fallback dropped somebody who had just paid
       * onto the marketing site, with no acknowledgement and no way back to
       * the chat they started in.
       *
       * The prefix is written by the one place that opens these, beside the
       * subscription row it belongs to.
       */
      if (reference.startsWith("sub_")) {
        const { rows } = await db().query<{ status: string }>(
          `SELECT status FROM subscriptions WHERE payment_reference = $1 LIMIT 1`,
          [reference],
        );

        const status = rows[0]?.status;
        if (!status) return reply.redirect(SITE, 303);

        /*
         * On to the page that was built for this.
         *
         * It used to render a page here that navigated straight to `wa.me`,
         * on the reasoning that WhatsApp intercepts its own links and the
         * browser would go away — leaving nothing to close. The trick is
         * real, but the redirect fired whether or not it worked, so what
         * somebody actually got after paying ₦4,000 was a success page for
         * four hundred milliseconds and then WhatsApp's own landing page.
         * The acknowledgement they paid for went past too fast to read.
         *
         * So: land on the page, and stop trying to leave it. `/pro/success`
         * says what happened, tries to close itself, and tells them they can
         * close it if that does not work — which is the honest order, since
         * no page can dismiss WhatsApp's browser on its own.
         *
         * Whether it claims Pro is on is still a checked fact: the webhook
         * is what activates a subscription and the browser can arrive first,
         * so the page is told which of the two this is.
         */
        const done = `${SITE}/pro/success${status === "active" ? "" : "?state=confirming"}`;
        return reply.redirect(done, 303);
      }

      const token = await tokenForReference(reference);
      if (!token) return reply.redirect(SITE, 303);
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
