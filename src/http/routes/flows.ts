/**
 * POST /flows/endpoint — what Meta calls while a form is open.
 *
 * Status codes are Meta's, not ours to choose: 432 tells it the signature
 * did not match, 421 that the request could not be decrypted (so the phone
 * fetches our public key again and retries), and a 200 carries the answer as
 * base64 text. See whatsapp/flows/endpoint.ts for what is answered.
 */

import type { FastifyInstance } from "fastify";
import { env } from "../../config.ts";
import { verifyMetaSignature } from "../../lib/crypto.ts";
import { answer, endpointKey, openEnvelope, sealResponse, type Envelope } from "../../whatsapp/flows/endpoint.ts";

export async function flowRoutes(app: FastifyInstance): Promise<void> {
  app.post("/flows/endpoint", async (req, reply) => {
    if (env.WA_APP_SECRET) {
      const valid = verifyMetaSignature(
        req.rawBody ?? Buffer.alloc(0),
        req.headers["x-hub-signature-256"] as string | undefined,
        env.WA_APP_SECRET,
      );
      if (!valid) {
        req.log.warn("flow endpoint request failed signature check");
        return reply.status(432).send();
      }
    }

    const key = await endpointKey();
    if (!key) {
      req.log.error("flow endpoint called with no key made; run npm run flows -- --endpoint-key");
      return reply.status(421).send();
    }

    let opened;
    try {
      opened = openEnvelope(req.body as Envelope, key);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "flow endpoint request could not be decrypted");
      return reply.status(421).send();
    }

    const out = await answer(opened.request, { log: req.log }).catch((err: unknown) => {
      req.log.error({ err }, "flow endpoint answer failed");
      // Better a line under the box than a form that says "Something went wrong".
      return {
        screen: "PAYOUT",
        data: {
          business_name: String(opened.request.data?.business_name ?? ""),
          email: String(opened.request.data?.email ?? ""),
          error_messages: { account_number: "Something went wrong on our side. Tap Check account again." },
        },
      };
    });

    return reply.type("text/plain").send(sealResponse(out, opened.aesKey, opened.iv));
  });
}
