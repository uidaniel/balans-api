/**
 * Entry point. Boots the HTTP server and shuts it down cleanly so in-flight
 * requests finish rather than being cut off mid-payment.
 */

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
