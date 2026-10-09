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
import { env } from "../config.ts";
import { LAUNCH } from "../broadcast/launch.ts";

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
  | "pro_active"
  | "payout_paid"
  | "security_alert"
  | "client_invoice"
  | "client_invoice_pdf"
  | "client_quote_pdf"
  | "client_paid"
  | "client_invoice_updated"
  | "client_quote"
  | "client_reminder"
  | "client_reminded"
  | "launch_setup"
  | "pro_ending_pay"
  | "pro_ended_pay"
  | "pro_last_day_pay"
  | "pro_free_pay";

export type TemplateSpec = {
  name: TemplateName;
  /** Meta's category. Utility covers transactional; marketing costs more. */
  category: "UTILITY" | "MARKETING";
  body: string;
  /** What each placeholder means, in order, for the submission and for us. */
  params: string[];
  example: string[];
  /** A fixed line under the body. */
  footer?: string;
  /**
   * One button that opens a link, the last part of which is filled per send.
   * `url` ends in `{{1}}`; `example` is a whole URL Meta can open to review.
   */
  button?: { text: string; url: string; example: string };
  /**
   * Or one button that opens one of our WhatsApp Flows, on `screen`. Meta
   * needs the Flow's id at submission, so it is looked up by `flow` (the key
   * in flows/definitions.ts) when the template is submitted.
   */
  flowButton?: { text: string; flow: string; screen: string };
  /**
   * A picture above the body. Meta wants a sample uploaded with the
   * submission and the real one by address on every send; `sample` is the
   * address the sample is fetched from.
   */
  header?: { type: "image" | "document"; sample: string };
};

/** Where the Pro Pay button goes: billing/pro-link.ts builds the same address. */
const PRO_START = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/pro/start`;

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

  /*
   * Pro switched on: paid for, or given from the admin. Outside the 24-hour
   * window this is what says so; `pro_renewal` was used before, which asks
   * for a price and says "renews", and Pro does neither.
   */
  /*
   * Paystack has paid card money out to the user's bank (payments/payouts.ts).
   * Found by polling, hours after the payment, so usually outside the window.
   */
  payout_paid: {
    name: "payout_paid",
    category: "UTILITY",
    body: "Your Balans payout of {{1}} for invoice {{2}} has been paid into {{3}}. Reply here to see your other invoices.",
    params: ["amount", "invoice number", "account"],
    example: ["₦350,000", "0014", "Access Bank ••5673"],
  },

  pro_active: {
    name: "pro_active",
    category: "UTILITY",
    body: "Your Balans Pro is active until {{1}}. Reply here to see what it adds.",
    params: ["until"],
    example: ["4 November"],
  },

  /*
   * Around the end of Pro (billing/subscription.ts, `ProStage`). Pro does not
   * renew by itself, so each says what happens next and carries the button
   * that pays: the same signed /pro/start link the chat's Pay button opens,
   * its token filling `{{1}}`. Each is sent once; outside the 24-hour window
   * these are what arrive.
   */
  pro_ending_pay: {
    name: "pro_ending_pay",
    category: "UTILITY",
    body: "Your Balans Pro ends on {{1}}. It does not renew by itself. Tap below to pay {{2}} for another month, starting when this one ends.",
    params: ["date", "price"],
    example: ["1 October", "₦3,000"],
    button: { text: "Renew Pro", url: `${PRO_START}?t={{1}}`, example: `${PRO_START}?t=example` },
  },

  pro_ended_pay: {
    name: "pro_ended_pay",
    category: "UTILITY",
    body: "Your Balans Pro ended on {{1}}. You keep every Pro feature until {{2}}. Tap below to renew for {{3}} a month.",
    params: ["date it ended", "grace end date", "price"],
    example: ["28 September", "5 October", "₦3,000"],
    button: { text: "Renew Pro", url: `${PRO_START}?t={{1}}`, example: `${PRO_START}?t=example` },
  },

  pro_last_day_pay: {
    name: "pro_last_day_pay",
    category: "UTILITY",
    body: "Your Balans Pro features stop on {{1}}, and your account moves to the Free plan. Tap below to keep Pro for {{2}} a month.",
    params: ["date", "price"],
    example: ["5 October", "₦3,000"],
    button: { text: "Keep Pro", url: `${PRO_START}?t={{1}}`, example: `${PRO_START}?t=example` },
  },

  pro_free_pay: {
    name: "pro_free_pay",
    category: "UTILITY",
    body: "Your Balans account is on the Free plan, with {{1}} invoices a month. Your logo and settings are saved. Tap below to get Pro back for {{2}} a month.",
    params: ["free invoices a month", "price"],
    example: ["3", "₦3,000"],
    button: { text: "Get Pro back", url: `${PRO_START}?t={{1}}`, example: `${PRO_START}?t=example` },
  },

  /*
   * A document, to the client it is for, from the Balans number.
   *
   * The first message anybody on the client's side gets from us, so it says
   * who it is from before anything else, and it is a utility message about
   * their invoice — no pitch in it, or Meta files it as marketing. The
   * footer is the only mention of Balans, and it is enough: the reply box
   * under it opens a chat with the product.
   */
  client_invoice: {
    name: "client_invoice",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has sent you {{3}} for {{4}}. Tap below to see it and how to pay.",
    params: ["client", "business", "what it is, e.g. Invoice 8", "amount"],
    example: ["Tunde", "Kemi Studio", "Invoice 8", "₦200,000"],
    footer: "Sent with Balans",
    button: {
      text: "View and pay",
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/{{1}}`,
      example: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  /*
   * The same two, with the PDF attached (7 October 2026). The PDF is what a
   * client saves and forwards to whoever pays it; a link alone left them to
   * download it themselves. Sent instead of the plain ones once Meta has
   * approved these (documents/client-whatsapp.ts), and the plain ones until.
   */
  client_invoice_pdf: {
    name: "client_invoice_pdf",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has sent you {{3}} for {{4}}. The invoice is attached. Tap below to pay.",
    params: ["client", "business", "what it is, e.g. Invoice 8", "amount"],
    example: ["Tunde", "Kemi Studio", "Invoice 8", "₦200,000"],
    footer: "Sent with Balans",
    header: { type: "document", sample: "src/whatsapp/samples/invoice-sample.pdf" },
    button: {
      text: "Pay now",
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/{{1}}`,
      example: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  client_quote_pdf: {
    name: "client_quote_pdf",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has sent you a quote for {{3}} ({{4}}). The quote is attached. Tap below to see it online.",
    params: ["client", "business", "amount", "Quote 3"],
    example: ["Tunde", "Kemi Studio", "₦450,000", "Quote 3"],
    footer: "Sent with Balans",
    header: { type: "document", sample: "src/whatsapp/samples/invoice-sample.pdf" },
    button: {
      text: "View quote",
      url: `${env.SITE_URL.replace(/\/$/, "")}/q/{{1}}`,
      example: `${env.SITE_URL.replace(/\/$/, "")}/q/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  /*
   * Proof of payment to a client who gave a number and no email (7 October
   * 2026). With an email, the receipt goes there instead and this is not sent.
   */
  /*
   * An invoice changed after it was sent (9 October 2026), with the new PDF.
   * Says "updated" so a client holding the first one pays the right amount.
   */
  client_invoice_updated: {
    name: "client_invoice_updated",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has updated {{3}}. It now comes to {{4}}. The updated invoice is attached and replaces the earlier one. Tap below to pay.",
    params: ["client", "business", "what it is, e.g. Invoice 8", "amount"],
    example: ["Tunde", "Kemi Studio", "Invoice 8", "₦200,000"],
    footer: "Sent with Balans",
    header: { type: "document", sample: "src/whatsapp/samples/invoice-sample.pdf" },
    button: {
      text: "Pay now",
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/{{1}}`,
      example: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  client_paid: {
    name: "client_paid",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has received your payment of {{3}} for {{4}}. Your receipt is attached. Thank you.",
    params: ["client", "business", "amount", "what it was for, e.g. Invoice 8"],
    example: ["Tunde", "Kemi Studio", "₦200,000", "Invoice 8"],
    footer: "Sent with Balans",
    header: { type: "document", sample: "src/whatsapp/samples/invoice-sample.pdf" },
  },

  client_quote: {
    name: "client_quote",
    category: "UTILITY",
    body: "Hello {{1}}, {{2}} has sent you a quote for {{3}} ({{4}}). Tap below to see it.",
    params: ["client", "business", "amount", "Quote 3"],
    example: ["Tunde", "Kemi Studio", "₦450,000", "Quote 3"],
    footer: "Sent with Balans",
    button: {
      text: "View quote",
      url: `${env.SITE_URL.replace(/\/$/, "")}/q/{{1}}`,
      example: `${env.SITE_URL.replace(/\/$/, "")}/q/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  /*
   * The reminder, sent to the client rather than handed to the freelancer to
   * forward. A template for the same reason `client_invoice` is: the client
   * has never written to us, so there is no window to send anything else in.
   *
   * "The invoice from {{2}}" rather than "{{2}}'s invoice": the possessive
   * turns "Daniel Adventures" into "Daniel Adventures's", and this goes to
   * somebody else's client. "Due {{4}}" reads the same for today and for a
   * date that has passed, and says nothing about anybody being late.
   */
  client_reminder: {
    name: "client_reminder",
    category: "UTILITY",
    body: "Hello {{1}}, a reminder about the invoice from {{2}} for {{3}}, due {{4}}. Tap below to see it and pay.",
    params: ["client", "business", "amount still owed", "due date, e.g. today or Mon, 28 Sep"],
    example: ["Tunde", "Kemi Studio", "₦200,000", "today"],
    footer: "Sent with Balans",
    button: {
      text: "View and pay",
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/{{1}}`,
      example: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/i/1256e3fd1f1fb85572609f61607c3fa6`,
    },
  },

  /*
   * Telling the freelancer their client was reminded, outside the window.
   *
   * `invoice_overdue_prompt` asks them to reply and send a reminder
   * themselves, which is wrong once Balans has already sent it. Starts with a
   * word rather than a placeholder, because Meta flags templates that open on
   * a variable.
   */
  /*
   * "We're live", to the waitlist. Marketing, because it goes to people who
   * asked to hear when Balans opened and have never written to us — about
   * $0.05 each in Nigeria, against a utility template's $0.007. The words
   * are in broadcast/launch.ts with the email, so the two cannot disagree.
   */
  launch_setup: {
    name: "launch_setup",
    category: "MARKETING",
    body: LAUNCH.whatsapp.body,
    params: [],
    example: [],
    footer: LAUNCH.whatsapp.footer,
    flowButton: LAUNCH.whatsapp.button,
    header: { type: "image", sample: LAUNCH.image },
  },

  client_reminded: {
    name: "client_reminded",
    category: "UTILITY",
    body: "We reminded {{1}} about invoice {{2}} for {{3}}, {{4}}. Nothing for you to do. We will tell you the moment it is paid.",
    params: ["client", "invoice number", "amount", "how, e.g. by email"],
    example: ["Zenith Homes", "14", "₦350,000", "by email and on WhatsApp"],
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
