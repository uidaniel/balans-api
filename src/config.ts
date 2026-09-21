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
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  SUPPORT_EMAIL: z.string().email().default("hello@balans.ng"),

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

export const defaults = {
  plans: {
    free: {
      documentsPerMonth: 5,
      feePercentBps: 100, // 1%
      feeMinKobo: 100_00,
      feeCapKobo: 1_000_00,
    },
    pro: {
      priceKobo: 4_000_00,
      documentsPerMonth: null,
      feePercentBps: 50, // 0.5%
      feeMinKobo: 50_00,
      feeCapKobo: 500_00,
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
