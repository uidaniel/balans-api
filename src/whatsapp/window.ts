/**
 * The 24-hour service window (PRD F16).
 *
 * WhatsApp lets a business reply freely for 24 hours after a user's last
 * message. Outside that, only templates Meta has approved in advance.
 *
 * This matters more here than it looks. The message a Balans user most wants
 * is "you have been paid", and it is the one most likely to fall outside the
 * window, because clients pay days after the invoice was made. A reminder is
 * outside by definition — the whole point is that the user is not chatting.
 * So a product that only sends free-form text works beautifully in testing and
 * goes quiet exactly when it matters.
 *
 * Nothing here guesses. The window is measured from the last inbound message
 * we recorded, and the send path asks before choosing how to send.
 */

import { db } from "../db/pool.ts";

/** Meta's window, with a margin. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sending right at the edge races the clock: the check passes, the request
 * takes a second, and Meta refuses it. Treating the last few minutes as
 * already outside costs a template message and avoids a silent failure.
 */
const EDGE_MS = 5 * 60 * 1000;

export type WindowState = {
  open: boolean;
  lastInboundAt: Date | null;
  /** Milliseconds left, for logs and for deciding how hard to hurry. */
  remainingMs: number;
};

export async function windowFor(userId: string, now = Date.now()): Promise<WindowState> {
  const { rows } = await db().query<{ at: Date | null }>(
    `SELECT MAX(created_at) AS at FROM messages
      WHERE user_id = $1 AND direction = 'in'`,
    [userId],
  );

  const at = rows[0]?.at ?? null;
  if (!at) return { open: false, lastInboundAt: null, remainingMs: 0 };

  const remainingMs = WINDOW_MS - (now - at.getTime());
  return { open: remainingMs > EDGE_MS, lastInboundAt: at, remainingMs: Math.max(0, remainingMs) };
}

/* -------------------------------------------------------------------------- */
/* Templates (F16)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The templates F16 names, with the copy submitted to Meta.
 *
 * Each one is a promise about what we will say when we cannot say anything
 * else, so the wording is the wording — a template whose text drifts from what
 * Meta approved is rejected at send time, not at deploy time.
 *
 * `{{1}}` placeholders are positional, which is Meta's model. The order here
 * is the order the arguments go in, and getting it wrong sends a client's name
 * where an amount belongs.
 */
export type TemplateName =
  | "payment_received"
  | "invoice_viewed"
  | "invoice_overdue_prompt"
  | "monthly_summary_ready"
  | "pro_renewal"
  | "security_alert";

export type TemplateSpec = {
  name: TemplateName;
  /** Meta's category. Utility covers transactional; marketing costs more. */
  category: "UTILITY" | "MARKETING";
  body: string;
  /** What each placeholder means, in order, for the submission and for us. */
  params: string[];
  example: string[];
};

export const TEMPLATES: Record<TemplateName, TemplateSpec> = {
  payment_received: {
    name: "payment_received",
    category: "UTILITY",
    // Not opening with a placeholder: Meta flags templates that begin with a
    // variable, and a message read cold needs a subject before a number.
    body: "You have been paid {{1}} by {{2}}. Invoice {{3}} is settled and the money is on its way to your bank.",
    params: ["amount", "client", "invoice number"],
    example: ["₦350,000", "Zenith Homes", "14"],
  },

  invoice_viewed: {
    name: "invoice_viewed",
    category: "UTILITY",
    body: "Good news: {{1}} has opened Invoice {{2}}. Nothing to do — we will tell you the moment it is paid.",
    params: ["client", "invoice number"],
    example: ["Zenith Homes", "14"],
  },

  invoice_overdue_prompt: {
    name: "invoice_overdue_prompt",
    category: "UTILITY",
    body: "Invoice {{1}} for {{2}} was due {{3}} and is still unpaid. Reply here to send {{4}} a reminder.",
    params: ["invoice number", "amount", "due date", "client"],
    example: ["14", "₦350,000", "Friday", "Zenith Homes"],
  },

  monthly_summary_ready: {
    name: "monthly_summary_ready",
    category: "UTILITY",
    body: "Your {{1}} summary is ready: {{2}} paid across {{3}} invoices. Reply here to see the detail.",
    params: ["month", "amount paid", "document count"],
    example: ["September", "₦675,000", "7"],
  },

  pro_renewal: {
    name: "pro_renewal",
    category: "UTILITY",
    body: "Your Balans Pro renews on {{1}} at {{2}}. Reply here to change or cancel it.",
    params: ["date", "amount"],
    example: ["1 October", "₦4,000"],
  },

  security_alert: {
    name: "security_alert",
    category: "UTILITY",
    body: "Security notice: {{1}} on your Balans account at {{2}}. If this was not you, reply here immediately.",
    params: ["what changed", "when"],
    example: ["your payout bank was changed", "14:20 today"],
  },
};

/** Meta wants a language code alongside the name on every send. */
export const TEMPLATE_LANGUAGE = "en";

/* -------------------------------------------------------------------------- */
/* Cost (F16: "estimated cost, so cost per invoice can be measured")          */
/* -------------------------------------------------------------------------- */

/**
 * What a message costs, in kobo.
 *
 * Free until 1 November 2025 for service messages, and from then Nigeria is
 * charged per message with utility and service priced separately. These are
 * estimates kept in one place so the number in the logs can be corrected
 * without hunting through call sites, and so "cost per completed invoice"
 * (section 15) is a query rather than a guess.
 *
 * PRD-GAP: section 17 lists the official Nigerian rates as an open question.
 * Confirm against Meta's current price list before these numbers are used for
 * anything but a rough measure.
 */
export const MESSAGE_COST_KOBO = {
  /** A free-form reply inside the window. */
  service: 14_00,
  /** A template outside it. Utility is cheaper than marketing. */
  utility: 14_00,
  marketing: 40_00,
} as const;

export function costOf(opts: { inWindow: boolean; category?: "UTILITY" | "MARKETING" }): number {
  if (opts.inWindow) return MESSAGE_COST_KOBO.service;
  return opts.category === "MARKETING" ? MESSAGE_COST_KOBO.marketing : MESSAGE_COST_KOBO.utility;
}
