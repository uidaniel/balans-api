/**
 * "Try an example" (5 November 2026): what a client receives, in the
 * sender's own name, before they have thought of a client.
 *
 * Half of the people who finish setup never send a document. A sample shows
 * the result without asking anything of them: their business name, their
 * design and logo, their bank account where a client would pay, a made-up
 * client and job, and SAMPLE across it. Drawn on the fly and saved nowhere,
 * so it is never a document, never numbered, and never counted.
 *
 * Drawn the way their first three documents are, with every Pro feature,
 * since that is what their first client will see.
 */

import { db } from "../db/pool.ts";
import { renderPdf, rendererAvailable } from "../pdf/chrome.ts";
import { renderDocumentHtml, type DocumentData } from "../pdf/template.ts";
import { renderTemplate } from "../pdf/templates.ts";
import { logoDataUri } from "../brand/user-logo.ts";
import { accountToStamp } from "./bank-details.ts";
import { legalLines } from "./pdf.ts";
import type { Civil } from "../../core/dates.ts";

const addDays = (d: Civil, n: number): Civil => {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** The example's job: plain enough for any trade, priced like a real one. */
export const SAMPLE_CLIENT = "Zenith Homes";
export const SAMPLE_LINES = [
  { description: "Design work, first stage", qty: 1, unitAmountKobo: 150_000_00, amountKobo: 150_000_00 },
  { description: "Revisions and final files", qty: 1, unitAmountKobo: 50_000_00, amountKobo: 50_000_00 },
];

export async function sampleData(userId: string, today: Civil): Promise<{ doc: DocumentData; templateId: string | null } | null> {
  const { rows } = await db().query<{
    business_name: string | null;
    email: string | null;
    address: string | null;
    tin: string | null;
    logo_url: string | null;
    template_id: string | null;
    brand_color: string | null;
  }>(
    `SELECT business_name, CASE WHEN email_verified_at IS NOT NULL THEN email END AS email,
            address, tin, logo_url, template_id, brand_color
       FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return null;
  const business = u.business_name ?? "Your business";
  const bank = await accountToStamp(userId).catch(() => null);
  const total = SAMPLE_LINES.reduce((a, l) => a + l.amountKobo, 0);
  return {
    templateId: u.template_id,
    doc: {
      variant: "sample",
      number: 1,
      businessName: business,
      businessEmail: u.email,
      businessAddress: u.address,
      businessTin: u.tin,
      logoDataUri: await logoDataUri(userId, "pro", u.logo_url),
      bankDetails: bank ? { bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber } : null,
      clientName: SAMPLE_CLIENT,
      clientEmail: null,
      lines: SAMPLE_LINES,
      subtotalKobo: total,
      vatKobo: 0,
      vatPercent: null,
      totalKobo: total,
      amountPaidKobo: 0,
      issueDate: today,
      dueDate: addDays(today, 7),
      notes: null,
      title: "Example invoice",
      publicUrl: null,
      legalLines: legalLines({ businessName: business }),
      showMadeWith: false,
      brandColor: u.brand_color,
    },
  };
}

/** The example as a PDF, or null when there is no renderer. */
export async function renderSamplePdf(userId: string, today: Civil): Promise<{ bytes: Buffer; filename: string } | null> {
  if (!rendererAvailable()) return null;
  const data = await sampleData(userId, today);
  if (!data) return null;
  const html = renderTemplate(data.templateId, data.doc) ?? renderDocumentHtml(data.doc);
  return { bytes: await renderPdf(html), filename: "Example invoice.pdf" };
}
