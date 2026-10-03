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
import { closeRenderer, warmRenderer } from "./pdf/chrome.ts";
import { buildServer } from "./http/server.ts";
import { emailTransport } from "./conversation/handle.ts";
import { modelConfigured } from "./parser/model.ts";
import { chromePath } from "./pdf/chrome.ts";
import { startScheduler, stopScheduler } from "./jobs/scheduler.ts";
import { migrate } from "./db/migrate.ts";
import { publishChangedFlows } from "./whatsapp/flows/register.ts";
import { submitMissingTemplates } from "./whatsapp/register-templates.ts";
import { startBroadcasts, stopBroadcasts } from "./jobs/broadcast.ts";
import { drainInbound, replayUnanswered } from "./http/routes/whatsapp.ts";

const app = buildServer();

/*
 * The schema first, then the code that needs it.
 *
 * Migrations used to be a separate `npm run migrate` somebody had to remember
 * after a push. On 26 September 2026 nobody did: the bank-details code went
 * live against a database without its columns, and every "Send it" failed
 * with "Something went wrong on our side" until they were added by hand.
 *
 * So the process applies what is pending before it listens. Each migration
 * runs in its own transaction and is recorded, so this is a no-op on every
 * boot but the first after one is added. A migration that fails stops the
 * boot: the health check never passes, and the deploy watcher puts the
 * previous commit back rather than serving code whose tables are missing.
 */
if (env.DATABASE_URL) {
  try {
    await migrate((m) => app.log.info(m));
  } catch (e) {
    app.log.fatal({ err: e }, "migrations failed, not starting");
    process.exit(1);
  }
}

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (e) {
  app.log.fatal({ err: e }, "failed to start");
  process.exit(1);
}

// What this process can actually do, said once at boot. Every one of these has
// already cost an hour of wondering why nothing happened, and each is a
// configuration fact rather than a failure — the bot works without any of
// them, it just works less.
app.log.info(
  {
    email: emailTransport(),
    parser: modelConfigured() ? env.PARSER_MODEL : "commands and patterns only",
    pdf: chromePath() ?? "no renderer found",
    jobs: env.JOBS_ENABLED ? `every ${Math.round(env.JOBS_INTERVAL_MS / 60000)}m` : "disabled",
    whatsapp: env.WA_PHONE_NUMBER_ID ? "configured" : "not configured",
    payments: env.PAYSTACK_SECRET_KEY ? (env.PAYSTACK_SECRET_KEY.startsWith("sk_live_") ? "paystack live" : "paystack test") : "not configured",
    publicBaseUrl: env.PUBLIC_BASE_URL,
  },
  "ready",
);

startScheduler(app.log);

// Chrome up and its tabs open now, not on the first invoice after a deploy.
void warmRenderer().catch((e) => app.log.warn({ err: (e as Error).message }, "could not warm the renderer"));

// Anything the last restart cut off mid-reply, answered now. See whatsapp.ts.
void replayUnanswered(app.log)
  .then((n) => n && app.log.warn({ count: n }, "answered messages a restart cut off"))
  .catch((e) => app.log.error({ err: (e as Error).message }, "could not replay cut-off messages"));

// The forms' screens live at Meta, not in this image. Publishing the ones that
// changed is what makes a push deploy a form as well as the code behind it.
// Not awaited: nothing about serving requests waits on Meta.
void publishChangedFlows(app.log).catch((e) =>
  app.log.error({ err: (e as Error).message }, "publishing Flows at boot failed"),
);
// Tests and the launch message, queued from the admin. Seconds, not the
// hourly scheduler: somebody who pressed "Send test" is watching their phone.
startBroadcasts(app.log);

// And the message templates the code sends, the same way.
void submitMissingTemplates(app.log).catch((e) =>
  app.log.error({ err: (e as Error).message }, "submitting templates at boot failed"),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, closing`);
    stopScheduler();
    stopBroadcasts();
    // Replies already under way get a few seconds to finish before we go.
    const waited = await drainInbound(7_000);
    if (waited) app.log.info({ waited }, "let in-flight replies finish");
    await app.close();
    await closeRenderer();
    await closeDb();
    process.exit(0);
  });
}
