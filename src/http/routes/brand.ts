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
import { proCard } from "../../billing/pro-card.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/brand");

/** Public name -> file on disk. Nothing outside this map is reachable. */
const FILES: Record<string, { file: string; type: string }> = {
  "welcome.jpg": { file: "welcome.jpg", type: "image/jpeg" },
  "setup-done.jpg": { file: "setup-done.jpg", type: "image/jpeg" },
  "cheatsheet.jpg": { file: "cheatsheet.jpg", type: "image/jpeg" },
  // The Free limit, with what Pro costs and what it removes.
  "limit.jpg": { file: "limit.jpg", type: "image/jpeg" },
  // The same offer without the "five done" headline, for anyone who asks
  // for Pro before they have run out.
  "upgrade.jpg": { file: "upgrade.jpg", type: "image/jpeg" },
  // The membership card, once the money is in.
  "pro.jpg": { file: "pro.jpg", type: "image/jpeg" },
  // The gold tick, on the page a confirmed email lands on (31 October 2026).
  "setup-tick.png": { file: "setup-tick.png", type: "image/png" },
};

/**
 * Read once, then kept.
 *
 * These are a few hundred kilobytes and never change between deploys, so the
 * alternative is reading the same bytes off disk every time Meta fetches one.
 */
const cache = new Map<string, Buffer>();

/** "2026-12" and nothing else. */
const MONTH = /^(\d{4})-(\d{2})$/;

export async function brandRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { m?: string } }>(
    "/brand/:name",
    async (req, reply) => {
    const wanted = FILES[req.params.name];
    if (!wanted) return reply.status(404).send({ error: "not found" });

    /*
     * The Pro card, with the month on it.
     *
     * "Member since <month>" is engraved on the gold card by the same browser
     * that renders the invoices (brand/cards.ts). The stock file has no line
     * at all, so a card that cannot be drawn says nothing rather than a
     * wrong month.
     *
     * A month in the URL rather than a user: it is the only thing that
     * varies, it is not private, and it means twelve possible images a year
     * — each built once and kept — instead of one per subscriber. A request
     * with no month, or a bad one, gets the stock card.
     */
    if (req.params.name === "pro.jpg" && req.query.m) {
      const parts = MONTH.exec(req.query.m);
      const year = Number(parts?.[1]);
      const month = Number(parts?.[2]);

      if (parts && month >= 1 && month <= 12 && year >= 2024 && year <= 2100) {
        try {
          const card = await proCard(month, year);
          if (card) {
            return reply
              .header("content-type", "image/jpeg")
              .header("cache-control", "public, max-age=31536000, immutable")
              .send(card);
          }
        } catch (e) {
          // The card is a nicety; the message it rides on is not. Falling back
          // to the stock card costs the month and saves the whole send.
          req.log.error({ err: (e as Error).message }, "could not draw the Pro card");
        }
      }
    }

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
    },
  );
}
