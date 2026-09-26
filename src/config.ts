/**
 * Configuration (PRD section 14).
 *
 * Everything that may change without a code deploy lives here or in the
 * `config` table. This module holds only what must exist before the database
 * does: secrets, connection details, and the entity switch. Commercial values
 * (prices, fees, limits) get their defaults here and are overridden at runtime
 * by `config` rows once that loader exists.
 *
 * Reading an absent secret throws at boot rather than at the first request, so
 * a misconfigured deployment fails immediately and visibly.
 */

import { z } from "zod";

const bool = (d: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? d : v === "true" || v === "1"));

const int = (d: number) => z.coerce.number().int().optional().default(d);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Postgres. Required everywhere except the unit tests. */
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL: bool(false),

  /* -- Entity switch (section 14). Moving to Balans Technologies Ltd is a
        configuration change, not a rebuild. ------------------------------- */
  LEGAL_ENTITY_NAME: z.string().default("MOTX Studios"),
  /**
   * Where public document pages live: the origin in every /i/{token} link.
   *
   * That is this API for now, because it serves the page. Section 3 puts the
   * invoice page in the web app eventually, and moving it is a change to this
   * one value plus a route there — the token in the link stays valid either
   * way, which matters, because those links are sent to clients and live in
   * WhatsApp threads forever.
   */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
  SUPPORT_EMAIL: z.string().email().default("hello@balans.ng"),
  /**
   * The marketing site: terms, privacy, the landing page.
   *
   * Deliberately separate from PUBLIC_BASE_URL. That one is wherever document
   * pages are served from, which is the API today and may be the web app
   * tomorrow; this is where the legal pages live and does not move with it.
   */
  SITE_URL: z.string().url().default("https://balans.ng"),

  /* -- WhatsApp Cloud API -------------------------------------------------- */
  WA_PHONE_NUMBER_ID: z.string().optional(),
  WA_BUSINESS_ACCOUNT_ID: z.string().optional(),
  /** Bearer token for the Graph API. Temporary tokens last 24 hours. */
  WA_ACCESS_TOKEN: z.string().optional(),
  /*
   * Send Flows in draft mode.
   *
   * Meta refuses to publish a Flow until the business behind it is verified,
   * and a draft one opens only for someone with developer access to the app.
   * So this is how the forms are tested before verification comes through —
   * and it must be off in production, where a draft opens for nobody.
   */
  WA_FLOWS_DRAFT: z.enum(["true", "false"]).optional(),
  /** Our own string, echoed back during Meta's webhook handshake. */
  WA_VERIFY_TOKEN: z.string().optional(),
  /** Meta app secret. Every inbound webhook is signed with it. */
  WA_APP_SECRET: z.string().optional(),
  WA_GRAPH_VERSION: z.string().default("v21.0"),

  /* -- Payments: Monnify --------------------------------------------------- */
  MONNIFY_BASE_URL: z.string().url().default("https://sandbox.monnify.com"),
  MONNIFY_API_KEY: z.string().optional(),
  MONNIFY_SECRET_KEY: z.string().optional(),
  /** Wallet the platform's own fee share settles into. */
  MONNIFY_CONTRACT_CODE: z.string().optional(),

  /* -- Payments: Paystack, for invoices priced abroad ---------------------- */
  /*
   * A second processor, not a replacement. Naira invoices go to Monnify and
   * always will; Paystack is here because it charges international cards, and
   * for nothing else. See the International PRD, section 8.
   *
   * Absent is a supported state and means exactly one thing: no international
   * invoicing. The feature flag below is the switch; these are the keys.
   */
  PAYSTACK_BASE_URL: z.string().url().default("https://api.paystack.co"),
  PAYSTACK_SECRET_KEY: z.string().optional(),

  /* -- International invoices ---------------------------------------------- */
  /**
   * The master switch (section 10). Off by default, and off everywhere until
   * every item in section 13's go-live gate is true.
   *
   * With it off, a message written in dollars still has to be *read* as
   * dollars — that is the whole point of the currency reader — and answered
   * with "not available yet". The dangerous alternative is a flag that makes
   * the product stop looking for foreign currency, which turns £500 back into
   * an invoice for ₦500.
   */
  INTL_ENABLED: bool(false),
  /**
   * Where the naira rate comes from. "open-er-api" or "fixed".
   *
   * "fixed" reads the two numbers below and is how the sandbox runs without
   * depending on somebody else's uptime — and how a rate gets pinned by hand
   * the morning a feed goes wrong.
   */
  FX_PROVIDER: z.string().default("open-er-api"),
  /** Section 6's default. A daily reference rate does not move within an hour. */
  FX_CACHE_MINUTES: int(60),
  /** Past this, a held rate is no longer evidence about today. Section 6. */
  FX_STALE_MAX_HOURS: int(24),
  FX_FIXED_USDNGN: z.coerce.number().positive().optional(),
  FX_FIXED_GBPNGN: z.coerce.number().positive().optional(),

  /* -- Parser (section 14: model and confidence threshold) ----------------- */
  /** Absent is a supported state: commands and the pattern still work. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * The architecture table asks for a small, cheap model with JSON output.
   *
   * Haiku, and the reason is the credit balance rather than the design. On a
   * parse of about 2,000 tokens in and 200 out, $4 of credit buys roughly
   * 1,300 messages on Haiku, 440 on Sonnet and 88 on Opus. Running out is not
   * a slower bot — it is a bot that cannot read a sentence at all, because
   * the model is the last resort behind the command and pattern readers.
   *
   * The way to make parsing better without spending more is to give the model
   * a better question, and that is what the draft block and the correction
   * schema in `parser/model.ts` do: most of what looked like stupidity was a
   * reply to "Send it?" arriving with no idea what was on screen.
   *
   * It is one environment variable when the credits are there:
   *   PARSER_MODEL=claude-sonnet-5   in /opt/balans/.env, then restart.
   */
  PARSER_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  /** Below this, a document intent is treated as unknown rather than drafted. */
  PARSER_CONFIDENCE_MIN: z.coerce.number().min(0).max(1).default(0.7),
  /** F3: longer inputs are rejected with a short message. */
  PARSER_MAX_CHARS: int(1000),
  /** A person is waiting in a chat window, so this is short on purpose. */
  PARSER_TIMEOUT_MS: int(8000),

  /* -- Background jobs (F13) ------------------------------------------------ */
  /** Off in tests and anywhere a second process should not also be sending. */
  JOBS_ENABLED: bool(true),
  /** Hourly: an invoice due at 9am is chased that morning, not the next day. */
  JOBS_INTERVAL_MS: int(3_600_000),

  /* -- PDF rendering (F20) -------------------------------------------------- */
  /** Where Chrome lives, when it is not in one of the usual places. */
  CHROME_PATH: z.string().optional(),
  /** The debugging port the headless browser listens on, locally only. */
  PDF_DEBUG_PORT: int(9222),
  /** F20 targets under 5 seconds at p95; this is the hard stop. */
  PDF_TIMEOUT_MS: int(15000),

  /* -- Encryption ---------------------------------------------------------- */
  /** 32 bytes, base64. Protects account numbers and TOTP secrets (section 11). */
  ENCRYPTION_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment:\n${lines.join("\n")}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/**
 * Throws unless every named variable is present.
 *
 * Call it from the thing that needs the secret, not at import time, so the unit
 * tests and the migration runner can load this module without a full
 * production environment.
 */
export function require_(...keys: (keyof typeof env)[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment: ${missing.join(", ")}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Commercial defaults (section 2). The `config` table overrides these.        */
/* -------------------------------------------------------------------------- */

/** Stored as users.consent_version when someone accepts (PRD section 12). */
export const legalConsentVersion = process.env.LEGAL_CONSENT_VERSION ?? "2026-09-draft-1";

export const defaults = {
  plans: {
    free: {
      documentsPerMonth: 3,
      feePercentBps: 100, // 1%
      feeMinKobo: 100_00,
      feeCapKobo: 1_000_00,
    },
    /*
     * Pro takes no transaction fee at all.
     *
     * It was 0.5%. On the numbers that is worth about ₦840 a month from a
     * user sending twelve invoices — a rounding error beside the ₦4,000
     * subscription, and it made the pitch conditional: "cheaper fees" is an
     * argument somebody has to do arithmetic to believe.
     *
     * Zero is a sentence instead: pay ₦4,000 and keep everything except what
     * the bank takes. For a freelancer billing ₦350,000 that is the difference
     * between ₦1,000 of Balans fees and none.
     *
     * All three must be zero together. `balansFee` clamps to the minimum after
     * applying the rate, so a 0% fee with a ₦50 floor still charges ₦50.
     */
    pro: {
      priceKobo: 4_000_00,
      documentsPerMonth: null,
      feePercentBps: 0,
      feeMinKobo: 0,
      feeCapKobo: 0,
    },
  },
  /*
   * International invoicing (International PRD sections 7 and 10).
   *
   * Every rate here is tagged [Assumed] in that PRD: widely reported, never
   * confirmed in writing by Paystack, and never yet seen on a real
   * settlement. They are defaults to build against and section 13 does not
   * let the feature go live until one real payment has been reconciled to the
   * kobo against them.
   */
  international: {
    /** Paystack's international card fee. 390 = 3.9%. */
    feePercentBps: 390,
    feeFlatKobo: 100_00,
    /** Zero until Paystack confirms VAT applies to the card fee. Then 7.5. */
    feeVatPercent: 0,
    /**
     * Per-invoice and per-user-per-day ceilings, in the foreign currency's
     * minor units: $1,000 and $2,000. A cap is not a judgement about the
     * work — it is the blast radius of a chargeback on a payment method we
     * have never yet taken, held small until we have.
     */
    invoiceCapMinor: 1_000_00,
    dailyCapMinor: 2_000_00,
    /**
     * What a user is told about when the money arrives.
     *
     * One string because it is a promise about somebody else's schedule that
     * nobody has confirmed. Monnify's "tonight" wording must never be used
     * for these: it is computed from a payout run at 22:00 Lagos that has
     * nothing to do with Paystack.
     */
    settlementText: "Usually in your bank within 1 to 2 business days.",
  },
  limits: {
    minInvoiceKobo: 1_000_00,
    maxInvoiceNewUserKobo: 200_000_00,
    maxInvoiceEstablishedKobo: 2_000_000_00,
    maxPerDayNewUserKobo: 500_000_00,
    lineItemsPerDocument: 20,
    samplesPerUser: 3,
    inboundPerMinute: 20,
  },
  behaviour: {
    defaultDueDays: 7,
    quoteValidDays: 14,
    /** Reminders never go outside these hours, Africa/Lagos. */
    quietHoursStart: 20,
    quietHoursEnd: 8,
    timezone: "Africa/Lagos",
    /**
     * The hour in Lagos that Monnify's daily payout run goes out.
     *
     * Configurable because it is a claim about somebody else's schedule. It
     * decides whether a payment notification says "tonight" or "tomorrow
     * night", which is a promise about the reader's own money.
     */
    settlementHour: 22,
    /** Parser text is purged after this many days (section 10). */
    parserTextRetentionDays: 30,
    /** A conversation returns to idle after this long without a message. */
    stateExpiryHours: 24,
  },
} as const;
