/**
 * Brand images, served so WhatsApp can fetch them.
 *
 * Meta will take an image either as an uploaded media id or as a URL it
 * fetches itself. The URL is the better of the two here: a media id expires
 * after thirty days, which means a cache, a re-upload path and a failure mode
 * that only appears a month after anybody last looked at it. A URL has none of
 * that, and the file is already in the repository being deployed.
 *
 * Deliberately a short, fixed list rather than a directory served wholesale.
 * The files are known at build time, and a path parameter that reaches the
 * filesystem is the kind of thing that quietly becomes a traversal bug.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/brand");

/** Public name -> file on disk. Nothing outside this map is reachable. */
const FILES: Record<string, { file: string; type: string }> = {
  "welcome.png": { file: "welcome.png", type: "image/png" },
  "setup-done.png": { file: "setup-done.png", type: "image/png" },
  "cheatsheet.png": { file: "cheatsheet.png", type: "image/png" },
};

/**
 * Read once, then kept.
 *
 * These are a few hundred kilobytes and never change between deploys, so the
 * alternative is reading the same bytes off disk every time Meta fetches one.
 */
const cache = new Map<string, Buffer>();

export async function brandRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string } }>("/brand/:name", async (req, reply) => {
    const wanted = FILES[req.params.name];
    if (!wanted) return reply.status(404).send({ error: "not found" });

    let bytes = cache.get(req.params.name);
    if (!bytes) {
      try {
        bytes = await readFile(path.join(DIR, wanted.file));
        cache.set(req.params.name, bytes);
      } catch (e) {
        req.log.error({ name: req.params.name, err: (e as Error).message }, "brand asset missing");
        return reply.status(404).send({ error: "not found" });
      }
    }

    // A year, immutable. The name changes when the image does, so there is
    // nothing to revalidate — and Meta refetches this on every welcome.
    return reply
      .header("content-type", wanted.type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(bytes);
  });
}
