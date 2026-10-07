/**
 * Submits the message templates to Meta for approval (PRD F16).
 *
 * "Templates to register before launch." Approval takes Meta anywhere from
 * minutes to a couple of days, and nothing outside the 24-hour window can be
 * sent until it is done — so this runs early and is safe to run again: a
 * template that already exists is reported, not duplicated.
 *
 *   npm run templates          list what exists and what is missing
 *   npm run templates -- --submit   create the missing ones
 */

import { env, require_ } from "../config.ts";
import { TEMPLATES, TEMPLATE_LANGUAGE, type TemplateSpec } from "./window.ts";
import { flowId } from "./flows/register.ts";

type Existing = { name: string; status: string; language: string; category?: string };

function url(path: string): string {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${path}`;
}

async function list(): Promise<Existing[]> {
  require_("WA_BUSINESS_ACCOUNT_ID", "WA_ACCESS_TOKEN");
  const res = await fetch(
    url(`${env.WA_BUSINESS_ACCOUNT_ID}/message_templates?limit=200&fields=name,status,language,category`),
    { headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` } },
  );
  const body = (await res.json()) as { data?: Existing[]; error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.data ?? [];
}

/**
 * The app the access token belongs to, which Meta's upload API is addressed
 * to. Read from the token rather than configured, so there is no second value
 * to keep in step with it.
 */
async function appId(): Promise<string | null> {
  const t = env.WA_ACCESS_TOKEN;
  const res = await fetch(url(`debug_token?input_token=${t}&access_token=${t}`));
  const body = (await res.json().catch(() => ({}))) as { data?: { app_id?: string } };
  return body.data?.app_id ?? null;
}

/**
 * A sample image for a template's header, uploaded the way Meta requires.
 *
 * A template with an image header cannot be submitted with a link: Meta wants
 * the file through its resumable upload API and a handle back, which goes in
 * the submission. The real image is sent by address on every message; this
 * is only what the reviewer looks at.
 */
async function uploadSample(address: string): Promise<{ ok: true; handle: string } | { ok: false; detail: string }> {
  const app = await appId();
  if (!app) return { ok: false, detail: "could not tell which app the token belongs to" };

  // A local file (the sample PDF lives in the repo) or an address.
  let bytes: Buffer;
  let type: string;
  if (/^https?:/.test(address)) {
    const file = await fetch(address);
    if (!file.ok) return { ok: false, detail: `the sample did not load: ${address} said ${file.status}` };
    bytes = Buffer.from(await file.arrayBuffer());
    type = file.headers.get("content-type") ?? "image/jpeg";
  } else {
    const { readFileSync } = await import("node:fs");
    bytes = readFileSync(address);
    type = address.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
  }
  const name = type === "application/pdf" ? "sample.pdf" : "header.jpg";

  const session = await fetch(
    url(`${app}/uploads?file_name=${name}&file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`),
    { method: "POST", headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` } },
  );
  const opened = (await session.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!opened.id) return { ok: false, detail: opened.error?.message ?? `upload session refused (${session.status})` };

  const sent = await fetch(url(opened.id), {
    method: "POST",
    headers: { authorization: `OAuth ${env.WA_ACCESS_TOKEN}`, file_offset: "0" },
    body: bytes,
  });
  const done = (await sent.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
  if (!done.h) return { ok: false, detail: done.error?.message ?? `upload refused (${sent.status})` };
  return { ok: true, handle: done.h };
}

async function create(spec: TemplateSpec): Promise<{ ok: boolean; detail: string }> {
  let header: Record<string, unknown> | null = null;
  if (spec.header) {
    const sample = await uploadSample(spec.header.sample);
    if (!sample.ok) return { ok: false, detail: `header ${spec.header.type}: ${sample.detail}` };
    header = {
      type: "HEADER",
      format: spec.header.type === "document" ? "DOCUMENT" : "IMAGE",
      example: { header_handle: [sample.handle] },
    };
  }

  let flowButton: Record<string, unknown> | null = null;
  if (spec.flowButton) {
    const id = await flowId(spec.flowButton.flow);
    if (!id) return { ok: false, detail: `the ${spec.flowButton.flow} form has no id yet; it is published at boot` };
    flowButton = {
      type: "FLOW",
      text: spec.flowButton.text,
      flow_id: id,
      navigate_screen: spec.flowButton.screen,
      flow_action: "navigate",
    };
  }

  const res = await fetch(url(`${env.WA_BUSINESS_ACCOUNT_ID}/message_templates`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: spec.name,
      language: TEMPLATE_LANGUAGE,
      category: spec.category,
      components: [
        ...(header ? [header] : []),
        {
          type: "BODY",
          text: spec.body,
          // Meta rejects a template with placeholders and no sample: it cannot
          // review copy it has never seen filled in. And one with a sample
          // but no placeholders, so the sample goes only where it is needed.
          ...(spec.params.length ? { example: { body_text: [spec.example] } } : {}),
        },
        ...(spec.footer ? [{ type: "FOOTER", text: spec.footer }] : []),
        ...(spec.button
          ? [
              {
                type: "BUTTONS",
                buttons: [
                  { type: "URL", text: spec.button.text, url: spec.button.url, example: [spec.button.example] },
                ],
              },
            ]
          : []),
        ...(flowButton ? [{ type: "BUTTONS", buttons: [flowButton] }] : []),
      ],
    }),
  });

  const body = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };
  if (!res.ok) return { ok: false, detail: body.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, detail: `${body.id} (${body.status ?? "submitted"})` };
}

/**
 * Submits every template in the code that Meta does not have yet.
 *
 * Run by the service at boot, so that a template added in a push goes to
 * Meta for approval without anybody remembering `npm run templates --
 * --submit` on a box they may not be able to reach. Only the missing ones:
 * an existing template, approved or waiting, is left exactly as it is.
 * Nothing here can fail the boot — a refused template is logged, and the
 * code that would send it already falls back when Meta refuses the send.
 */
export async function submitMissingTemplates(log: {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}): Promise<void> {
  if (!env.WA_ACCESS_TOKEN || !env.WA_BUSINESS_ACCOUNT_ID) return;
  let existing: Existing[];
  try {
    existing = await list();
  } catch (e) {
    log.warn({ err: (e as Error).message }, "could not list templates at Meta; submitting none");
    return;
  }
  const have = new Set(existing.map((t) => t.name));
  for (const spec of Object.values(TEMPLATES)) {
    if (have.has(spec.name)) continue;
    const made = await create(spec);
    if (made.ok) log.info({ template: spec.name, detail: made.detail }, "template submitted to Meta at boot");
    else log.warn({ template: spec.name, detail: made.detail }, "template refused by Meta at boot");
  }
}

/**
 * Every template's status at Meta, written to `config` as `template_status`.
 *
 * For the admin, which has no Meta key of its own and needs to say whether
 * the launch message can go yet. Refreshed at boot and by the broadcast loop,
 * so an approval shows up within minutes rather than at the next deploy.
 */
export async function recordTemplateStatuses(): Promise<Record<string, string> | null> {
  if (!env.WA_ACCESS_TOKEN || !env.WA_BUSINESS_ACCOUNT_ID) return null;
  const existing = await list().catch(() => null);
  if (!existing) return null;
  const statuses = Object.fromEntries(existing.map((t) => [t.name, t.status]));
  const { db } = await import("../db/pool.ts");
  await db().query(
    `INSERT INTO config (key, value_json, updated_by) VALUES ('template_status', $1::jsonb, 'templates')
       ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(statuses)],
  );
  return statuses;
}

export async function registerTemplates(submit: boolean): Promise<void> {
  const existing = await list();
  const byName = new Map(existing.map((t) => [t.name, t]));

  console.log(`WhatsApp templates on this account: ${existing.length}\n`);

  for (const spec of Object.values(TEMPLATES)) {
    const found = byName.get(spec.name);

    if (found) {
      const mark = found.status === "APPROVED" ? "ok  " : "wait";
      console.log(`  ${mark} ${spec.name.padEnd(24)} ${found.status}`);
      continue;
    }

    if (!submit) {
      console.log(`  --   ${spec.name.padEnd(24)} MISSING`);
      continue;
    }

    const made = await create(spec);
    console.log(`  ${made.ok ? "new " : "FAIL"} ${spec.name.padEnd(24)} ${made.detail}`);
  }

  const missing = Object.values(TEMPLATES).filter((t) => !byName.has(t.name));
  if (missing.length && !submit) {
    console.log(`\n${missing.length} missing. Run with --submit to create them.`);
  }
  console.log(
    "\nApproval is Meta's, and it takes minutes to days. Nothing outside the",
    "\n24-hour window can be sent until a template is APPROVED.",
  );
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  try {
    await registerTemplates(process.argv.includes("--submit"));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
