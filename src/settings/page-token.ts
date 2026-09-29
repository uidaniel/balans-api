/**
 * The link to the settings page.
 *
 * Opened from a WhatsApp button, and the page can change where somebody's
 * money goes, so the link is a random token stored against the user that
 * lapses a day after it was last issued: a link found in a chat export next
 * month opens nothing. Reused while live, as the signature link is, so two
 * messages that each carry it both keep working.
 *
 * The token is only the door. Changing the payout account behind it still
 * takes the code emailed to the verified address.
 */

import { randomBytes } from "node:crypto";
import { env } from "../config.ts";
import { db } from "../db/pool.ts";

export async function settingsUrlFor(userId: string): Promise<string> {
  const { rows } = await db().query<{ settings_token: string }>(
    `UPDATE users
        SET settings_token = COALESCE(
              CASE WHEN settings_token_expires_at > now() THEN settings_token END,
              $2),
            settings_token_expires_at = now() + interval '1 day'
      WHERE id = $1
      RETURNING settings_token`,
    [userId, randomBytes(16).toString("hex")],
  );
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/settings/${rows[0]!.settings_token}`;
}

/** Whose settings these are, while the link is live; null otherwise. */
export async function ownerOfSettingsToken(token: string): Promise<{ id: string } | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const { rows } = await db().query<{ id: string }>(
    `SELECT id FROM users
      WHERE settings_token = $1 AND settings_token_expires_at > now() AND status = 'active'`,
    [token],
  );
  return rows[0] ?? null;
}
