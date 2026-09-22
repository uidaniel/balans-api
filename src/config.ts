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

  /* -- Parser (section 14: model and confidence threshold) ----------------- */
  /** Absent is a supported state: commands and the pattern still work. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** The architecture table asks for a small, cheap model with JSON output. */
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
      documentsPerMonth: 5,
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
    /** Parser text is purged after this many days (section 10). */
    parserTextRetentionDays: 30,
    /** A conversation returns to idle after this long without a message. */
    stateExpiryHours: 24,
  },
} as const;
