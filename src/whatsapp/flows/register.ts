/**
 * Creates and publishes the Flows at Meta.
 *
 *   npm run flows            create or update, then publish
 *   npm run flows -- --draft create or update, leave unpublished
 *   npm run flows -- --list  what exists now
 *
 * Run it whenever `definitions.ts` changes. Meta validates the Flow JSON on
 * upload and refuses it with line and column numbers, which is the only
 * feedback there is — a Flow that compiles is not a Flow that reads well, and
 * that part still has to be opened on a phone.
 *
 * Published ids are written to `config`, which is where the running service
 * reads them from. They are not hard-coded: a flow recreated after a mistake
 * gets a new id, and a constant in a file would then point at nothing.
 */

import { closeDb, db } from "../../db/pool.ts";
import { env } from "../../config.ts";
import { FLOWS, type FlowDefinition } from "./definitions.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

type Existing = { id: string; name: string; status: string };

async function graph(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function listFlows(): Promise<Existing[]> {
  const body = (await graph(`${env.WA_BUSINESS_ACCOUNT_ID}/flows`)) as { data?: Existing[] };
  return body.data ?? [];
}

/**
 * The published id, by key.
 *
 * `config` already exists for values that must change without a deploy, which
 * is exactly what this is.
 */
export async function saveFlowId(key: string, id: string): Promise<void> {
  await db().query(
    `INSERT INTO config (key, value_json, updated_by) VALUES ($1, to_jsonb($2::text), 'flows:register')
       ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [`flow_id.${key}`, id],
  );
}

export async function flowId(key: string): Promise<string | null> {
  const { rows } = await db().query<{ value: string }>(
    `SELECT value_json #>> '{}' AS value FROM config WHERE key = $1`,
    [`flow_id.${key}`],
  );
  return rows[0]?.value ?? null;
}

async function upload(id: string, def: FlowDefinition): Promise<void> {
  // The asset endpoint is multipart, not JSON: the Flow JSON goes up as a file
  // called flow.json, which is the only name it accepts.
  const form = new FormData();
  form.append("name", "flow.json");
  form.append("asset_type", "FLOW_JSON");
  form.append("file", new Blob([JSON.stringify(def.json)], { type: "application/json" }), "flow.json");

  const res = await fetch(`${GRAPH}/${id}/assets`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    validation_errors?: { message?: string; line_start?: number; column_start?: number }[];
  };

  const errors = body.validation_errors ?? [];
  if (!res.ok || errors.length) {
    for (const e of errors) {
      console.error(`  ✖ ${e.message ?? "invalid"}${e.line_start ? ` (line ${e.line_start})` : ""}`);
    }
    throw new Error(`${def.key}: Flow JSON rejected`);
  }
}

async function register(def: FlowDefinition, existing: Existing[], publish: boolean): Promise<void> {
  const found = existing.find((f) => f.name === def.name);

  let id: string;
  if (found) {
    id = found.id;
    console.log(`${def.key}: updating ${id} (${found.status})`);
    await upload(id, def);
  } else {
    // Create takes the JSON inline, which saves a round trip and gets the
    // validation errors back in the same response.
    const body = (await graph(`${env.WA_BUSINESS_ACCOUNT_ID}/flows`, {
      method: "POST",
      body: JSON.stringify({
        name: def.name,
        categories: def.categories,
        flow_json: JSON.stringify(def.json),
      }),
    })) as { id?: string; validation_errors?: { message?: string }[] };

    for (const e of body.validation_errors ?? []) console.error(`  ✖ ${e.message}`);
    if (!body.id) throw new Error(`${def.key}: not created`);
    id = body.id;
    console.log(`${def.key}: created ${id}`);
  }

  if (publish) {
    // A published Flow can be sent to anybody. A draft can only be opened by
    // someone with developer access to the app, which is what --draft is for.
    await graph(`${id}/publish`, { method: "POST" });
    console.log(`${def.key}: published`);
  }

  await saveFlowId(def.key, id);
}

if (
  process.argv[1] &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);

  try {
    const existing = await listFlows();

    if (args.includes("--list")) {
      if (!existing.length) console.log("no flows yet");
      for (const f of existing) console.log(`${f.id}  ${f.status.padEnd(10)} ${f.name}`);
    } else {
      const publish = !args.includes("--draft");
      for (const def of FLOWS) await register(def, existing, publish);
      console.log(`\n${FLOWS.length} flow(s) ${publish ? "published" : "left as drafts"}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
