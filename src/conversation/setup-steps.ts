/**
 * Where people stop in setup (5 November 2026).
 *
 * 92 of 194 started and never finished, and all we knew was that they did not
 * finish. Each step is written the first time somebody reaches it, so the
 * admin can count how many got to each one (view admin_setup_steps).
 *
 * The steps, in order: the welcome card ("welcome"), each screen of the setup
 * form as it is submitted ("business", "code", "payout", "mfb", "confirm",
 * "terms", "abroad"), and the chat steps for anybody setting up by typing
 * ("onboarding:bank" and the rest, by conversation state).
 *
 * Never in the way: a failure here is logged nowhere and changes nothing.
 */

import { db } from "../db/pool.ts";

export async function noteSetupStep(userId: string, step: string): Promise<void> {
  try {
    await db().query(`INSERT INTO setup_steps (user_id, step) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, step.slice(0, 40)]);
  } catch {
    // No database (a test), or a hiccup: setup goes on regardless.
  }
}
