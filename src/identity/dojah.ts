/**
 * Dojah, the licensed provider our identity checks go through (20 October
 * 2026). A NIN may only be looked up through a provider licensed by NIMC, so
 * nothing here talks to NIMC itself.
 *
 * Three calls, as documented at docs.dojah.io:
 *
 *   - `POST /api/v1/ml/liveness`: is the selfie a live person, not a photo of
 *     a photo or a screen;
 *   - `POST /api/v1/kyc/nin/verify`: the NIN's record, and whether the selfie
 *     matches the photo on it (`selfie_verification.match`, at `threshold`);
 *   - `GET /api/v1/kyc/cac/advance`: a business on the CAC register, with its
 *     directors and proprietors (`affiliates`).
 *
 * The secret key goes in `Authorization` as it is, not as `Bearer`, which
 * Dojah refuses with a 401. Images go as bare base64, without a data: prefix.
 *
 * Every answer is reduced to what the checks need before it leaves this file.
 * The NIN record can carry a photo; it is dropped here and never stored.
 */

import { env } from "../config.ts";

export const identityConfigured = (): boolean => Boolean(env.DOJAH_APP_ID && env.DOJAH_SECRET_KEY);

/** Dojah's own default, and strict on purpose: a weak match goes to a person. */
export const SELFIE_THRESHOLD = 90;

export type Failure = { ok: false; status: number; message: string };

async function call<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: T } | Failure> {
  try {
    const res = await fetchImpl(`${env.DOJAH_BASE_URL.replace(/\/$/, "")}${path}`, {
      method: init.method,
      headers: {
        Authorization: env.DOJAH_SECRET_KEY ?? "",
        AppId: env.DOJAH_APP_ID ?? "",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) {
      return { ok: false, status: res.status, message: body?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

/** Bare base64, whatever the page sent. */
export const bareBase64 = (image: string): string => image.replace(/^data:[^;]+;base64,/, "");

export async function liveness(
  image: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; live: boolean; probability: number | null; faces: number } | Failure> {
  /*
   * Two shapes. The one documented when this was written (`liveness_check`,
   * `face_detected`), and the one Dojah actually returns now (checked against
   * the sandbox, 2 November 2026): `liveness: { spoof, confidence }` and
   * `face: { detected, message }`. Read with only the old names, every selfie
   * came back "not a live face".
   */
  const r = await call<{
    entity?: {
      liveness?: { liveness_check?: boolean; liveness_probability?: number; spoof?: boolean; confidence?: number };
      face?: { face_detected?: boolean; multiface_detected?: boolean; detected?: boolean; message?: string };
    };
  }>("/api/v1/ml/liveness", { method: "POST", body: { image: bareBase64(image) } }, fetchImpl);
  if (!r.ok) return r;
  const e = r.body.entity;
  const l = e?.liveness;
  const f = e?.face;
  const detected = f?.detected === true || f?.face_detected === true;
  const several = f?.multiface_detected === true || /multiple|more than one/i.test(f?.message ?? "");
  const real = typeof l?.spoof === "boolean" ? l.spoof === false : l?.liveness_check === true;
  const probability =
    typeof l?.spoof === "boolean" && typeof l.confidence === "number"
      ? // How sure it is that this is a live person, out of 100.
        l.spoof ? 100 - l.confidence : l.confidence
      : typeof l?.liveness_probability === "number"
        ? l.liveness_probability
        : null;
  return {
    ok: true,
    live: real && detected && !several,
    probability,
    faces: several ? 2 : detected ? 1 : 0,
  };
}

export type NinRecord = {
  first: string;
  middle: string | null;
  last: string;
  match: boolean;
  confidence: number | null;
};

export async function ninWithSelfie(
  nin: string,
  selfie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; record: NinRecord } | Failure> {
  const r = await call<{
    entity?: Record<string, unknown> & {
      selfie_verification?: { match?: boolean; confidence_value?: number };
    };
  }>(
    "/api/v1/kyc/nin/verify",
    { method: "POST", body: { nin, selfie_image: bareBase64(selfie), threshold: SELFIE_THRESHOLD } },
    fetchImpl,
  );
  if (!r.ok) return r;
  const e = r.body.entity ?? {};
  const s = (k: string): string => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
  // The NIN record spells them `firstname` / `surname`; the BVN one
  // `first_name` / `last_name`. Either is read.
  const first = s("firstname") || s("first_name");
  const last = s("surname") || s("last_name");
  const middle = s("middlename") || s("middle_name") || null;
  if (!first || !last) return { ok: false, status: 404, message: "no name on the NIN record" };
  const v = e.selfie_verification;
  return {
    ok: true,
    record: {
      first,
      middle,
      last,
      match: v?.match === true,
      confidence: typeof v?.confidence_value === "number" ? v.confidence_value : null,
    },
  };
}

export type CompanyType = "BUSINESS_NAME" | "COMPANY";

export type CacRecord = {
  name: string;
  status: string | null;
  people: { first: string | null; middle: string | null; last: string | null; role: string | null }[];
};

export async function cacLookup(
  regNumber: string,
  type: CompanyType,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; record: CacRecord } | Failure> {
  const q = new URLSearchParams({ rc_number: regNumber, company_type: type });
  const r = await call<{
    entity?: {
      company_name?: string;
      status?: string;
      affiliates?: { first_name?: string; middle_name?: string; last_name?: string; affiliate_type?: string }[];
    };
  }>(`/api/v1/kyc/cac/advance?${q}`, { method: "GET" }, fetchImpl);
  if (!r.ok) return r;
  const e = r.body.entity;
  if (!e?.company_name) return { ok: false, status: 404, message: "no company on the CAC record" };
  return {
    ok: true,
    record: {
      name: e.company_name,
      status: e.status ?? null,
      people: (e.affiliates ?? []).map((a) => ({
        first: a.first_name ?? null,
        middle: a.middle_name ?? null,
        last: a.last_name ?? null,
        role: a.affiliate_type ?? null,
      })),
    },
  };
}
