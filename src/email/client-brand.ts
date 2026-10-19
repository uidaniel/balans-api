/**
 * Who an email to a client is from: Balans, or — on Pro — the business alone.
 *
 * Pro is sold as invoices that are the business's own. So everything a Pro
 * user's client receives by email carries their name, their logo and their
 * colour, and has no Balans coin or footer. The sender still reads "Their
 * Business via Balans" on every plan (decided 29 September 2026): the client
 * sees who it is from and how it reached them. The address stays on our
 * domain, which holds the SPF and DKIM records; a reply goes to the business.
 */

import { db } from "../db/pool.ts";
import { get as getFile } from "../storage/files.ts";
import type { ClientBrand, InlineImage } from "./layout.ts";

/**
 * `plan` is the document's (19 October 2026): a trial invoice keeps its
 * branding after the trial is used, and a paid month's invoices keep it
 * while the account is paying. Each caller has it from its own query.
 */
export async function clientBrandFor(userId: string, plan: string): Promise<ClientBrand | null> {
  if (plan !== "pro") return null;
  const { rows } = await db().query<{
    business_name: string | null;
    logo_url: string | null;
    brand_color: string | null;
  }>(`SELECT business_name, logo_url, brand_color FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) return null;

  let logo: InlineImage | null = null;
  if (u.logo_url) {
    const file = await getFile(u.logo_url).catch(() => null);
    if (file) {
      logo = {
        cid: "brand-logo",
        file: `logo.${file.contentType.split("/")[1] ?? "png"}`,
        bytes: file.bytes,
        contentType: file.contentType,
        alt: u.business_name ?? "",
        // Sized by the header's max-height; these only satisfy the type.
        width: 0,
        height: 0,
      };
    }
  }

  return { name: u.business_name ?? "", logo, colour: u.brand_color };
}

/** The pieces of an `Email` that change when it is sent as the business. */
export function sentAs(business: string, brand: ClientBrand | null) {
  const fromName = `${business} via Balans`;
  return brand
    ? { fromName, noMark: true, images: brand.logo ? [brand.logo] : [] }
    : { fromName, noMark: false, images: [] as InlineImage[] };
}
