/**
 * Consent that is asked for on its own (terms and privacy 6.0, 4 November
 * 2026; migration 0067).
 *
 * The data protection directive (GAID 2025, Art. 18(1)(e) and 27(4)) wants a
 * specific yes before personal data goes to a country the Commission has not
 * approved. Ours go to Ireland and the United States, so setup asks with its
 * own box, and existing users are asked once with the 6.0 notice.
 */

import { db } from "../db/pool.ts";
import { NEXT_CONSENT } from "../config.ts";

/**
 * The one box at the end of setup (4 November 2026): the terms, and the
 * transfer named in the same sentence. Chosen over a second box to keep setup
 * short; the transfer is still named outright, not left to the notice.
 */
export const TERMS_LABEL = "I agree to the Terms and the Privacy Notice, including my data being processed outside Nigeria";

/** Sent with that box, so only a form that showed this wording records the transfer. */
export const TERMS_WORDING = "2";

/** Records the yes to processing outside Nigeria. Never throws. */
export async function recordTransferConsent(userId: string): Promise<void> {
  await Promise.resolve()
    .then(() =>
      db().query(`UPDATE users SET transfer_consent_at = COALESCE(transfer_consent_at, now()) WHERE id = $1`, [userId]),
    )
    .catch(() => {});
}

/**
 * "I accept" under the 6.0 notice: the new version, and the yes to processing
 * outside Nigeria that comes with it. Only for somebody who has finished
 * setup; returns whether anything was recorded.
 */
export async function acceptNextTerms(userId: string): Promise<boolean> {
  return Promise.resolve()
    .then(() =>
      db().query(
        `UPDATE users SET consent_version = $2, consented_at = now(),
                          transfer_consent_at = COALESCE(transfer_consent_at, now())
          WHERE id = $1 AND consented_at IS NOT NULL`,
        [userId, NEXT_CONSENT.version],
      ),
    )
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);
}
