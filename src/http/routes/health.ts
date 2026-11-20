import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { env } from "../../config.ts";
import { db } from "../../db/pool.ts";

/**
 * The commit this build was made from, written by deploy/deploy.sh before it
 * builds (20 November 2026). "unknown" on a laptop, or on a build made before
 * the script wrote it. Read once: a build never changes under itself.
 */
export const VERSION = (() => {
  try {
    return readFileSync(new URL("../../../VERSION", import.meta.url), "utf8").trim().slice(0, 40) || "unknown";
  } catch {
    return "unknown";
  }
})();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness, and which build is answering, so a deploy can be checked from
   * outside. Answers even when Postgres is down, so it never traps a deploy.
   */
  app.get("/health", async () => ({ ok: true, env: env.NODE_ENV, version: VERSION }));

  /** Readiness. Reports the database rather than assuming it. */
  app.get("/ready", async (_req, reply) => {
    try {
      const { rows } = await db().query<{ n: number }>("SELECT 1 AS n");
      return { ok: rows[0]?.n === 1, db: "up" };
    } catch (e) {
      // The reason is logged, not handed to whoever asked: it can name hosts.
      reply.request.log.warn({ err: (e as Error).message }, "ready check: database down");
      reply.status(503);
      return { ok: false, db: "down" };
    }
  });
}
