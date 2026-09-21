import type { FastifyInstance } from "fastify";
import { env } from "../../config.ts";
import { db } from "../../db/pool.ts";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness. Answers even when Postgres is down, so it never traps a deploy. */
  app.get("/health", async () => ({ ok: true, env: env.NODE_ENV }));

  /** Readiness. Reports the database rather than assuming it. */
  app.get("/ready", async (_req, reply) => {
    try {
      const { rows } = await db().query<{ n: number }>("SELECT 1 AS n");
      return { ok: rows[0]?.n === 1, db: "up" };
    } catch (e) {
      reply.status(503);
      return { ok: false, db: "down", reason: (e as Error).message };
    }
  });
}
