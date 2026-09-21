/**
 * Entry point. Boots the HTTP server and shuts it down cleanly so in-flight
 * requests finish rather than being cut off mid-payment.
 */

import { Agent, setGlobalDispatcher } from "undici";
import { setDefaultResultOrder } from "node:dns";

/**
 * Make every outbound request use IPv4.
 *
 * graph.facebook.com publishes both an A and an AAAA record. Where the IPv6
 * path is broken — as it is on at least one network this has run on — a send to
 * Meta dies with a connect timeout ten seconds later, while inbound webhooks
 * keep arriving perfectly. The symptom is a bot that reads every message and
 * answers none, which looks nothing like a networking fault.
 *
 * `setDefaultResultOrder` alone is not enough: it changes what `dns.lookup`
 * returns, but undici — which backs `fetch` — does its own connecting and
 * ignores it. Happy Eyeballs did not save it either. Pinning the dispatcher's
 * connector to family 4 is what actually works, and it costs nothing on a
 * network where IPv6 is healthy.
 */
setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import { env } from "./config.ts";
import { closeDb } from "./db/pool.ts";
import { buildServer } from "./http/server.ts";

const app = buildServer();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (e) {
  app.log.fatal({ err: e }, "failed to start");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, closing`);
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
