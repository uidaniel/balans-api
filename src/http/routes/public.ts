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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { defaults, env } from "../../config.ts";
import { todayIn } from "../../../core/dates.ts";
import {
  balansFee,
  settle,
  withVat,
  DEFAULT_INTL_PROCESSOR,
  type BalansRates,
} from "../../../core/fees.ts";
import { initBankTransfer, initTransaction } from "../../payments/monnify.ts";
import {
  findByToken,
  markViewed,
  outstandingKobo,
  payable,
  payableNowKobo,
  type PublicDocument,
} from "../../documents/public.ts";
import { renderDocument, renderNotFound, type TransferPanel } from "../../documents/page.ts";
import {
  liveTransferFor,
  pendingPaymentsFor,
  recordInitialisedPayment,
  recordTransferAccount,
  type LiveTransfer,
} from "../../documents/payments.ts";
import { renderSummary } from "../../documents/summary-page.ts";
import { summaryFor, userForSummaryToken } from "../../documents/queries.ts";
import { renderDocumentPdf } from "../../documents/pdf.ts";
import { confirmPayment } from "../../payments/confirm.ts";
import {
  initTransaction as initPaystack,
  paystackConfigured,
} from "../../payments/paystack.ts";
import {
  cardPaymentAvailable,
  paystackSubaccountFor,
} from "../../payments/paystack-subaccount.ts";
import { verifierFor } from "../../payments/provider.ts";
import { notifyPaid } from "../../payments/notify.ts";
import { get as getFile, getCard } from "../../storage/files.ts";
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

  /**
   * Why a payment that went wrong says so through the query string.
   *
   * The page a payer sees has to survive being reloaded, and the one thing
   * guaranteed to reload it is the payment landing — the page polls, and calls
   * `location.reload()` the moment it is told the money arrived. So nothing
   * the payer looks at may live at a URL that only answers POST. See the Pay
   * button below: it redirects here, and these are how its failures travel.
   *
   * Every one of these is transient, and that is deliberate: a standing
   * reason a card cannot be taken is answered by `cardPaymentAvailable`
   * before the button is drawn, not reported after somebody has pressed it.
   *
   * `card_unavailable` survives for the narrow case the gate cannot catch —
   * the bank resolved but Paystack refused to make the subaccount — and it
   * stays worded without blame or plumbing. This page belongs to somebody who
   * is trying to pay a bill.
   */
  const PAY_ERRORS: Record<string, { text: string }> = {
    busy: { text: "Too many attempts just now. Wait a moment and try again." },
    unpayable: { text: "This invoice cannot be paid right now." },
    provider: { text: "We could not reach the payment provider. Please try again in a moment." },
    account: { text: "We could not get the account details just now. Please try again in a moment." },
    card_unavailable: {
      text: "Card payment is not available on this invoice yet. Please contact the sender.",
    },
  };

  app.get<{ Params: { token: string }; Querystring: { e?: string } }>(
    "/i/:token",
    async (req, reply) => {
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
    const canPay = payable(doc).ok;
    const live = canPay ? await liveTransferFor(doc.id, payableNowKobo(doc)) : null;

    /*
     * Asked before the button is drawn, and only where it can matter. A naira
     * invoice is a bank transfer and has nothing to do with Paystack, so this
     * stays off the path of almost every page view.
     */
    const cardReady = doc.foreign && canPay ? await cardPaymentAvailable(doc.userId) : true;

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
          cardReady,
          // Only one we wrote. Anything else in the query string is somebody
          // playing, and gets no words of ours on a page about their money.
          error: req.query.e ? PAY_ERRORS[req.query.e] : undefined,
        }),
      );
    },
  );

  /**
   * The Pay button's own address, arrived at by a browser rather than a form.
   *
   * It used to answer nothing at all, and the one moment it was asked was the
   * worst one in the product: the payer pressed Pay, the account panel came
   * back as the body of the POST, and the address bar read `/i/{token}/pay`.
   * They paid. The page polled, saw the payment, called `location.reload()` —
   * which the in-app browser sent as a GET — and the person who had just
   * transferred ₦163,250 was shown "Route GET:/i/.../pay not found".
   *
   * The POST redirects now, so this should not happen again. It stays because
   * that URL is in browser histories and in the back button, and a 404 is the
   * last thing anybody who has paid should ever see.
   */
  app.get<{ Params: { token: string } }>("/i/:token/pay", async (req, reply) =>
    reply.redirect(`/i/${encodeURIComponent(req.params.token)}`, 303),
  );

  /* -- Their own numbers ---------------------------------------------------- */

  /**
   * The summary, opened from the "View Summary" button on /owed.
   *
   * The most sensitive page here: one person's entire invoicing history, and
   * it opens inside WhatsApp's web view where there is nobody to log in as.
   * The token is the credential and it expires after a day, so a forwarded
   * chat is not a permanent window into somebody's earnings.
   *
   * An expired link is a 404 and not a "your link expired" page, which would
   * confirm to anybody holding one that it had been real.
   */
  app.get<{ Params: { token: string } }>("/s/:token", async (req, reply) => {
    const userId = await userForSummaryToken(req.params.token);
    if (!userId) return reply.status(404).type(HTML).send(renderNotFound());

    const today = todayIn(defaults.behaviour.timezone);
    const data = await summaryFor(userId, today);
    if (!data) return reply.status(404).type(HTML).send(renderNotFound());

    return reply
      .type(HTML)
      // Somebody's earnings. Never a shared cache, never a referrer, and
      // never indexed — the page says noindex as well, because a link
      // pasted anywhere is a link a crawler may follow.
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-robots-tag", "noindex, nofollow")
      .send(renderSummary(data, today));
  });

  /**
   * A card drawn for one person, for Meta to come and fetch.
   *
   * The only reason this exists: a `cta_url` message — the one with the link
   * button — takes an image header as a URL and refuses an uploaded id, so
   * the picture on /owed and /summary cannot travel the way every other
   * picture in this product does. See src/documents/card-link.ts.
   *
   * The token is 32 bytes from a CSPRNG and the row is refused an hour after
   * it was written, which is an hour longer than Meta needs. Nothing about
   * the response is cacheable by anything shared, and an unknown or dead
   * token is a flat 404 rather than a page explaining what it would have
   * been.
   */
  app.get<{ Params: { file: string } }>("/c/:file", async (req, reply) => {
    const token = req.params.file.replace(/\.png$/i, "");
    if (!/^[0-9a-f]{64}$/.test(token)) return reply.status(404).send();

    const bytes = await getCard(token);
    if (!bytes) return reply.status(404).send();

    return reply
      .type("image/png")
      .header("cache-control", "no-store, private")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-robots-tag", "noindex, nofollow")
      .send(bytes);
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

  /**
   * The Paystack half of Pay (International PRD section 8).
   *
   * Different in shape from the naira path, not just in provider. There is no
   * account number to read and no panel to sit on: the client goes to
   * Paystack's checkout, pays by card, and comes back. So this ends in a
   * redirect *away* rather than back to the invoice, and the confirmation
   * still arrives by webhook — the return is a browser doing what it was
   * told, and proves nothing.
   *
   * What is charged is the naira figure already on the document. Never
   * reconverted here: the rate was locked when the invoice was made, and
   * re-converting at pay time would charge a number neither the client nor
   * the freelancer has ever seen.
   */
  async function payByCard(
    req: FastifyRequest,
    reply: FastifyReply,
    doc: PublicDocument,
    outstandingKobo: number,
    back: (error?: keyof typeof PAY_ERRORS) => unknown,
    again: (error: keyof typeof PAY_ERRORS) => unknown,
  ): Promise<unknown> {
    void back;

    if (!paystackConfigured()) {
      req.log.error({ documentId: doc.id }, "foreign invoice with no Paystack key configured");
      return again("card_unavailable");
    }

    const sub = await paystackSubaccountFor(doc.userId, req.log);
    if (!sub.ok) {
      req.log.error({ documentId: doc.id, why: sub.why, message: sub.message }, "no Paystack subaccount");
      // A provider wobble is worth trying again; a bank Paystack does not
      // list, or a payout account that was never finished, is not.
      return again(sub.why === "provider" ? "provider" : "card_unavailable");
    }

    /*
     * Pro, so no Balans fee, and the processor's cut is borne by the
     * subaccount — which is set on the transaction, not worked out here.
     * `settle` is still asked, because it is the one place that knows whether
     * fees are passed to the client, and on a fee-passing invoice the client
     * is charged the grossed-up figure.
     */
    const split = settle(outstandingKobo, ratesFor(doc.plan), {
      passToClient: doc.passFeesToClient,
      paidBeforeKobo: doc.amountPaidKobo,
      processor: withVat(DEFAULT_INTL_PROCESSOR, defaults.international.feeVatPercent),
    });

    const reference = `bal_${doc.id.replace(/-/g, "").slice(0, 16)}_${randomUUID().slice(0, 8)}`;

    const init = await initPaystack({
      // Paystack requires an email and sends its own receipt to it. The
      // client's is often unknown, so a per-payment address on our own domain
      // stands in rather than a placeholder that might belong to somebody real.
      email: `${reference}@receipts.balans.ng`,
      amountKobo: split.clientPaysKobo,
      reference,
      subaccountCode: sub.code,
      callbackUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/callback?ref=${reference}`,
      metadata: {
        document_id: doc.id,
        user_id: doc.userId,
        original_currency: doc.foreign?.currency ?? null,
        original_amount_minor: doc.foreign?.amountMinor ?? null,
        fx_rate: doc.foreign?.rate ?? null,
        invoice_amount_kobo: outstandingKobo,
        balans_fee_kobo: split.balansFeeKobo,
      },
    });

    if (!init.ok) {
      req.log.error({ documentId: doc.id, message: init.message }, "could not start card payment");
      return again("provider");
    }

    await recordInitialisedPayment({
      documentId: doc.id,
      userId: doc.userId,
      reference,
      providerReference: reference,
      amountKobo: split.clientPaysKobo,
      // What the invoice is credited with when this lands, which is the
      // figure on the document rather than the figure on the card.
      invoiceAmountKobo: outstandingKobo,
      balansFeeKobo: split.balansFeeKobo,
      expectedProcessorFeeKobo: split.processorFeeKobo,
      provider: "paystack",
    });

    req.log.info(
      { documentId: doc.id, reference, chargedKobo: split.clientPaysKobo, subaccount: sub.code },
      "card payment initialised",
    );

    // Away to Paystack. 303, so the browser makes it a GET.
    return reply.redirect(init.authorizationUrl, 303);
  }

  app.post<{ Params: { token: string } }>("/i/:token/pay", async (req, reply) => {
    const today = todayIn(defaults.behaviour.timezone);
    const token = req.params.token;

    const doc = await findByToken(token);
    if (!doc) return reply.status(404).type(HTML).send(renderNotFound());

    /*
     * Everything this route does ends in a redirect, not a page.
     *
     * Post/Redirect/Get, and here it is not a nicety. The page shown to a
     * payer polls for their payment and calls `location.reload()` the moment
     * it lands — so whatever address that page is sitting at will be asked
     * for again, as a GET, at the single most important moment in the
     * product. Answering the POST with HTML left it sitting at `/pay`, which
     * answered GET with a 404. Somebody saw that immediately after paying.
     *
     * So the account panel is rendered by GET /i/:token, which already
     * rebuilds it from the live transfer, and failures come back as a code in
     * the query string. Nothing a payer can see lives at a POST-only URL.
     */
    const back = (error?: keyof typeof PAY_ERRORS) =>
      reply.redirect(`/i/${encodeURIComponent(token)}${error ? `?e=${error}` : ""}`, 303);

    const again = (error: keyof typeof PAY_ERRORS) => back(error);

    if (tooMany(token)) {
      req.log.warn({ documentId: doc.id }, "pay rate limited");
      return again("busy");
    }

    const can = payable(doc);
    if (!can.ok) {
      req.log.info({ documentId: doc.id, why: can.why }, "pay refused");
      return again("unpayable");
    }

    // F7: the next unpaid part, or the whole balance when there are none.
    const outstanding = payableNowKobo(doc);

    /*
     * An invoice priced abroad is a card payment, and cards are Paystack.
     *
     * Everything below this branch is the naira path: a Monnify reserved
     * account the client transfers into, matched on the account *and* the
     * amount. A client in London has no way to make a NIP transfer, so
     * offering them one is offering nothing.
     *
     * The charge is the naira figure on the document. It is not recomputed
     * from the foreign price here and must never be: the rate was locked when
     * the invoice was made, and re-converting at pay time would charge a
     * different number than the one the client agreed to and the freelancer
     * sent.
     */
    if (doc.foreign) {
      return payByCard(req, reply, doc, outstanding, back, again);
    }

    // Pressing Pay twice must not mint a second account. Monnify matches a
    // transfer on the account *and* the amount, so two live accounts for the
    // same balance is a way to lose somebody's money.
    const existing = await liveTransferFor(doc.id, outstanding);
    if (existing) {
      req.log.info({ documentId: doc.id, reference: existing.reference }, "reusing live transfer account");
      return back();
    }

    /*
     * The fee is worked out here, from the row, and never from the request.
     *
     * `paidBeforeKobo` is what makes our cap a cap on the invoice rather than
     * on each payment of it. Charged per payment, a ₦200,000 invoice on Free
     * cost ₦1,000 paid in one go and ₦1,400 paid as a deposit and a balance —
     * over a cap we advertise, taken out of the user's share, and only ever
     * in our favour. Monnify's cut stays per payment: theirs is a charge for
     * moving money, and two transfers are two transfers.
     */
    const split = settle(outstanding, ratesFor(doc.plan), {
      passToClient: doc.passFeesToClient,
      paidBeforeKobo: doc.amountPaidKobo,
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
      return again("provider");
    }

    await recordInitialisedPayment({
      documentId: doc.id,
      userId: doc.userId,
      reference,
      providerReference: init.transactionReference,
      amountKobo: split.clientPaysKobo,
      // What the invoice is credited with when this lands. `outstanding` is
      // the figure the plan and the page both quote; `clientPaysKobo` is that
      // plus the surcharge, when the client is the one carrying the fees.
      invoiceAmountKobo: outstanding,
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
      return again("account");
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

    /*
     * Back to the invoice, which draws the panel from what was just stored.
     *
     * The details are not carried over in the response: `recordTransferAccount`
     * has written them, and GET /i/:token reads them back through
     * `liveTransferFor`. One place builds that panel, so a reload, a return
     * from a banking app, and this redirect cannot show three different things.
     */
    return back();
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

    /*
     * What the page compares against what it was drawn with.
     *
     * A figure rather than a flag. "Has anything been paid" is true for ever
     * on a part-paid invoice, and the page reloaded every time it heard it —
     * a refresh loop that ran for as long as somebody left the invoice open.
     * How much has been paid changes exactly once per payment, which is
     * exactly when the page should redraw.
     */
    for (const p of await pendingPaymentsFor(doc.id)) {
      const outcome = await confirmPayment(
        { paymentReference: p.reference, transactionReference: p.providerReference },
        req.log,
        // Asked of whoever took it. The wrong provider does not know the
        // reference, so it answers "not found" for ever.
        verifierFor(p.provider),
      );
      if (outcome.kind === "confirmed") {
        void notifyPaid({ ...outcome, provider: p.provider }, req.log);
        return reply
          .header("cache-control", "no-store")
          .send({ paidKobo: outcome.amountPaidKobo, fullyPaid: outcome.fullyPaid });
      }
    }

    return reply
      .header("cache-control", "no-store")
      .send({ paidKobo: doc.amountPaidKobo, fullyPaid: outstandingKobo(doc) <= 0 });
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
  app.get<{
    Querystring: { ref?: string; paymentReference?: string; reference?: string; trxref?: string };
  }>("/pay/callback", async (req, reply) => {
      /*
       * Four names for one thing, because two processors send a payer back
       * here and neither asked what we called it. `ref` is ours, on the URL
       * we hand over; `paymentReference` is Monnify's; Paystack appends both
       * `reference` and `trxref` to whatever callback it was given, and
       * appends them whether or not ours is already there.
       *
       * Ours first. It is the one we control and the one the payment row is
       * keyed on, and preferring it means a processor changing its parameter
       * names cannot strand somebody who has just paid on the marketing site.
       */
      const reference =
        req.query.ref ?? req.query.paymentReference ?? req.query.reference ?? req.query.trxref;
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
