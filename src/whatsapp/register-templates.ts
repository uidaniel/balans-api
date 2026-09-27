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

async function create(spec: TemplateSpec): Promise<{ ok: boolean; detail: string }> {
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
        {
          type: "BODY",
          text: spec.body,
          // Meta rejects a template with placeholders and no sample: it cannot
          // review copy it has never seen filled in.
          example: { body_text: [spec.example] },
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
