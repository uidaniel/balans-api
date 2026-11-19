/**
 * Pro notices that Meta files as marketing go by email instead (19 November 2026).
 *
 * Meta moved every pro_* template to MARKETING, the reworded pro_plan_* ones
 * too. Inside the 24-hour window nothing changes: the notice is a chat
 * message. Outside it, the template that would go is checked against the
 * category Meta last gave it (config `template_category`, refreshed hourly by
 * recordTemplateStatuses). If it is marketing, the notice goes by email to a
 * confirmed address: free, and always delivered, where a marketing template
 * costs about ₦64 and may be held back by Meta's limit on marketing messages
 * per person, which a billing notice cannot afford. The day Meta files one as
 * utility again, it is used again, with nothing to change here.
 */

import type { FastifyBaseLogger } from "fastify";

import { db } from "../db/pool.ts";
import { env } from "../config.ts";
import { sendEmail } from "../email/send.ts";
import { button, layout, paragraph } from "../email/layout.ts";
import { esc } from "../documents/page.ts";
import type { TemplateName } from "../whatsapp/window.ts";

/** The first of these Meta has approved, and whether Meta files it as marketing. */
export async function marketingWouldBeUsed(names: TemplateName[]): Promise<boolean> {
  const { rows } = await db()
    .query<{ key: string; v: Record<string, string | null> }>(
      `SELECT key, value_json AS v FROM config WHERE key IN ('template_status', 'template_category')`,
    )
    .catch(() => ({ rows: [] as { key: string; v: Record<string, string | null> }[] }));
  const status = rows.find((r) => r.key === "template_status")?.v ?? {};
  const category = rows.find((r) => r.key === "template_category")?.v ?? {};
  const used = names.find((n) => status[n] === "APPROVED");
  return used ? category[used] === "MARKETING" : false;
}

/** WhatsApp's *bold* and _italic_ as an email's HTML, paragraph by paragraph. */
export function waToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      paragraph(
        esc(p)
          .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
          .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>")
          .replace(/\n/g, "<br>"),
      ),
    )
    .join("\n");
}

/** The words without WhatsApp's marks, for the plain-text part. */
const plain = (text: string) => text.replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2");

/**
 * The notice by email. "no_email" when there is no confirmed address, so the
 * caller can fall back to the template rather than say nothing.
 */
export async function emailProNotice(
  o: { userId: string; subject: string; text: string; label?: string; url?: string },
  log: FastifyBaseLogger,
): Promise<"sent" | "no_email" | "failed"> {
  const { rows } = await db().query<{ email: string | null }>(
    `SELECT CASE WHEN email_verified_at IS NOT NULL THEN email END AS email FROM users WHERE id = $1`,
    [o.userId],
  );
  const to = rows[0]?.email;
  if (!to) return "no_email";
  const out = await sendEmail(
    {
      to,
      sender: "support",
      subject: o.subject,
      replyTo: env.SUPPORT_EMAIL,
      text: [plain(o.text), "", ...(o.url ? [`${o.label ?? "Open"}: ${o.url}`] : [])].join("\n"),
      html: layout({
        preheader: plain(o.text).split("\n").find((l) => l.trim())?.slice(0, 110) ?? o.subject,
        heading: o.subject,
        body: [waToHtml(o.text), o.url ? button(o.label ?? "Open", o.url) : ""].join("\n"),
      }),
    },
    log,
  ).catch(() => ({ ok: false as const }));
  return (out as { ok?: boolean }).ok === false ? "failed" : "sent";
}
