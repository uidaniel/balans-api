/**
 * Puts a test number back to its first-ever message.
 *
 *   npm run reset -- 2348107408438        start onboarding again, same user
 *   npm run reset -- 2348107408438 --hard delete the user entirely
 *   npm run reset -- --last               whoever messaged most recently
 *
 * For development. Onboarding has six steps and a real bank lookup in the
 * middle, so walking it repeatedly is the only way to know it works — and
 * hand-editing rows between attempts is how you end up testing a state that
 * could never occur in practice.
 *
 * The soft reset keeps the user row and clears everything onboarding set, which
 * is the more useful default: `users.id` stays stable, so anything already
 * pointing at it still resolves.
 */

import { closeDb, db, tx } from "./pool.ts";

type Target = { id: string; waPhone: string; businessName: string | null };

async function find(phone: string | undefined): Promise<Target | null> {
  const { rows } = phone
    ? await db().query<{ id: string; wa_phone: string; business_name: string | null }>(
        `SELECT id, wa_phone, business_name FROM users WHERE wa_phone = $1`,
        [phone],
      )
    : await db().query<{ id: string; wa_phone: string; business_name: string | null }>(
        `SELECT u.id, u.wa_phone, u.business_name
           FROM users u
           LEFT JOIN conversations c ON c.user_id = u.id
          ORDER BY COALESCE(c.updated_at, u.created_at) DESC
          LIMIT 1`,
      );

  const r = rows[0];
  return r ? { id: r.id, waPhone: r.wa_phone, businessName: r.business_name } : null;
}

export async function softReset(userId: string): Promise<void> {
  await tx(async (c) => {
    // Bank accounts and codes are onboarding's output, so they go. Documents
    // and payments are not touched: losing a payment record to a convenience
    // script is not a trade worth making, even in development.
    await c.query(`DELETE FROM bank_accounts WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM verification_codes WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);

    // Messages go too, or the next "Hi" is treated as a duplicate delivery and
    // silently ignored — the wa_message_id is already on file.
    await c.query(`DELETE FROM messages WHERE user_id = $1`, [userId]);

    await c.query(
      `UPDATE users
          SET business_name = NULL, email = NULL, email_verified_at = NULL,
              consent_version = NULL, consented_at = NULL, activated_setup_at = NULL,
              address = NULL, tin = NULL, logo_url = NULL,
              plan = 'free', status = 'active', risk_tier = 'new'
        WHERE id = $1`,
      [userId],
    );
  });
}

export async function hardReset(userId: string): Promise<void> {
  /*
   * Most things are ON DELETE CASCADE from users, but money is not: payments,
   * the fee ledger and the documents they point at refuse to go by accident.
   * This is the one place they go on purpose, children first.
   */
  await tx(async (c) => {
    const docs = `SELECT id FROM documents WHERE user_id = $1`;
    await c.query(
      `DELETE FROM fee_ledger
        WHERE user_id = $1 OR payment_id IN (SELECT id FROM payments WHERE document_id IN (${docs}))`,
      [userId],
    );
    await c.query(`DELETE FROM payments WHERE document_id IN (${docs})`, [userId]);
    await c.query(`UPDATE documents SET parent_id = NULL WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM documents WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM recurring_schedules WHERE client_id IN (SELECT id FROM clients WHERE user_id = $1)`, [userId]);
    await c.query(`DELETE FROM clients WHERE user_id = $1`, [userId]);
    await c.query(`UPDATE users SET referred_by = NULL WHERE referred_by = $1`, [userId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const hard = args.includes("--hard");
  const phone = args.find((a) => !a.startsWith("--"));

  try {
    const target = await find(phone);

    if (!target) {
      console.error(phone ? `No user with wa_phone ${phone}` : "No users yet.");
      process.exitCode = 1;
    } else if (hard) {
      await hardReset(target.id);
      console.log(`deleted ${target.waPhone} entirely — the next message creates them fresh`);
    } else {
      await softReset(target.id);
      console.log(
        `${target.waPhone} reset${target.businessName ? ` (was "${target.businessName}")` : ""}` +
          ` — send it anything and onboarding starts from the top`,
      );
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
