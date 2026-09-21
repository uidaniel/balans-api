/**
 * Every message we send, through one door (PRD F16).
 *
 * Before this, each caller sent its own text and found out about the 24-hour
 * window when Meta refused it. That is fine for a reply, which is by
 * definition inside the window, and useless for everything the product does
 * while nobody is watching: payment notices, reminders, summaries.
 *
 * So the rule is: say what you want to send and what template says it when we
 * cannot. This picks. Callers no longer think about the window at all, and
 * every send is logged with its window state and estimated cost, which is what
 * makes "cost per completed invoice" a query instead of a guess.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/pool.ts";
import { sendDocument, sendTemplate, sendText, uploadDocument } from "./client.ts";
import { costOf, windowFor, TEMPLATES, TEMPLATE_LANGUAGE, type TemplateName } from "./window.ts";

export type Outbound = {
  userId: string;
  phone: string;
  /** What to say inside the window. */
  text: string;
  /**
   * What to send outside it.
   *
   * Absent means the message is not worth a template: it will be skipped
   * rather than sent late or sent wrong. A reply to a question nobody asked
   * three days ago is noise.
   */
  fallback?: { template: TemplateName; params: string[] };
  /** Attached inside the window only; templates cannot carry a file. */
  document?: { bytes: Buffer; filename: string };
};

export type SendOutcome =
  | { kind: "sent"; inWindow: boolean; template?: TemplateName }
  | { kind: "skipped"; why: "outside_window_no_template" }
  | { kind: "failed"; reason: string };

/**
 * Sends, choosing the form that will actually arrive.
 *
 * Never throws. Every caller is doing something more important than the
 * message — recording a payment, finishing a document — and a send failure
 * must not undo it.
 */
export async function send(msg: Outbound, log: FastifyBaseLogger): Promise<SendOutcome> {
  try {
    const win = await windowFor(msg.userId);

    if (win.open) {
      const outcome = await sendInside(msg, log);
      await record(msg.userId, outcome, { inWindow: true });
      return outcome;
    }

    if (!msg.fallback) {
      log.info(
        { userId: msg.userId, lastInboundAt: win.lastInboundAt },
        "outside the window and nothing worth a template; skipped",
      );
      await record(msg.userId, { kind: "skipped", why: "outside_window_no_template" }, { inWindow: false });
      return { kind: "skipped", why: "outside_window_no_template" };
    }

    const spec = TEMPLATES[msg.fallback.template];
    // A template whose parameter count does not match what Meta approved is
    // rejected on arrival. Catching it here names the bug instead.
    if (msg.fallback.params.length !== spec.params.length) {
      const reason = `template ${spec.name} wants ${spec.params.length} parameters (${spec.params.join(", ")}), got ${msg.fallback.params.length}`;
      log.error({ userId: msg.userId }, reason);
      return { kind: "failed", reason };
    }

    const res = await sendTemplate(msg.phone, spec.name, msg.fallback.params, {
      language: TEMPLATE_LANGUAGE,
    });

    const outcome: SendOutcome = res.ok
      ? { kind: "sent", inWindow: false, template: spec.name }
      : { kind: "failed", reason: res.reason };

    if (!res.ok) {
      log.error(
        { userId: msg.userId, template: spec.name, reason: res.reason, code: res.code },
        "template send failed",
      );
    }

    await record(msg.userId, outcome, {
      inWindow: false,
      template: spec.name,
      category: spec.category,
      waMessageId: res.ok ? res.waMessageId : null,
    });
    return outcome;
  } catch (err) {
    log.error({ err, userId: msg.userId }, "could not send");
    return { kind: "failed", reason: (err as Error).message };
  }
}

/** Inside the window: free-form, with the file attached if there is one. */
async function sendInside(msg: Outbound, log: FastifyBaseLogger): Promise<SendOutcome> {
  if (msg.document) {
    const up = await uploadDocument(msg.document.bytes, msg.document.filename);
    if (up.ok) {
      const res = await sendDocument(msg.phone, up.mediaId, msg.document.filename, msg.text);
      if (res.ok) return { kind: "sent", inWindow: true };
      log.error({ userId: msg.userId, reason: res.reason }, "document send failed; falling back to text");
    } else {
      log.error({ userId: msg.userId, reason: up.reason }, "document upload failed; falling back to text");
    }
    // The words matter more than the file.
  }

  const res = await sendText(msg.phone, msg.text);
  return res.ok
    ? { kind: "sent", inWindow: true }
    : { kind: "failed", reason: res.reason };
}

/**
 * Logs what went out (F16).
 *
 * Type, template, window state and estimated cost, on every message. The cost
 * is an estimate by construction — Meta's price list is not an API — but an
 * estimate recorded consistently is what makes the total meaningful.
 */
async function record(
  userId: string,
  outcome: SendOutcome,
  meta: {
    inWindow: boolean;
    template?: string;
    category?: "UTILITY" | "MARKETING";
    waMessageId?: string | null;
  },
): Promise<void> {
  const status =
    outcome.kind === "sent" ? "sent" : outcome.kind === "skipped" ? "skipped" : "failed";

  // A skipped message costs nothing; a failed one was never delivered.
  const cost = outcome.kind === "sent" ? costOf({ inWindow: meta.inWindow, category: meta.category }) : 0;

  await db()
    .query(
      `INSERT INTO messages
         (user_id, wa_message_id, direction, kind, template, in_window, cost_estimate_kobo, status)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [
        userId,
        meta.waMessageId ?? null,
        meta.template ? "template" : "text",
        meta.template ?? null,
        meta.inWindow,
        cost,
        status,
      ],
    )
    .catch(() => {
      /* The message went; losing the log entry must not undo that. */
    });
}

/* -------------------------------------------------------------------------- */

/** What messages have cost a user this month, for section 15's measure. */
export async function messageCostThisMonth(userId: string): Promise<{ count: number; kobo: number }> {
  const { rows } = await db().query<{ n: string; kobo: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cost_estimate_kobo), 0) AS kobo
       FROM messages
      WHERE user_id = $1 AND direction = 'out' AND status = 'sent'
        AND created_at >= date_trunc('month', now())`,
    [userId],
  );
  return { count: Number(rows[0]?.n ?? 0), kobo: Number(rows[0]?.kobo ?? 0) };
}
