/**
 * The providers, and what they do when the answer is wrong.
 *
 * A rate provider is somebody else's JSON, reached over somebody else's
 * network, and the failure that matters is not the one where it times out —
 * that is loud and the caller handles it. It is the one where it answers 200
 * with a body that is missing the field, or has it as null, or has it as a
 * string, or quotes the pair the other way round. Each of those becomes a
 * number, and a number becomes a price on somebody's invoice.
 *
 * So every test here is a provider answering successfully and being refused.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sourceFor } from "./sources.ts";

const NO_FIXED = {};

/** A fetch that answers once, with whatever is handed to it. */
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("the free daily feed", () => {
  const source = sourceFor("open-er-api", NO_FIXED)!;

  it("reads the naira rate out of a good response", async () => {
    const quoted = await source.quote(
      "USD",
      answering({ result: "success", base_code: "USD", rates: { NGN: 1326.871066, GHS: 12 } }),
    );
    assert.equal(quoted?.rate, 1326.871066);
  });

  it("keeps the whole response, for the day a provider starts lying", async () => {
    const body = { result: "success", time_last_update_utc: "Thu, 24 Sep 2026 00:02:32 +0000", rates: { NGN: 1327 } };
    const quoted = await source.quote("USD", answering(body));
    assert.deepEqual(quoted?.raw, body);
  });

  it("refuses an answer with no naira in it", async () => {
    // The pair we asked about simply not being there. Reading `undefined` as
    // a number is how an invoice ends up priced at NaN or at nothing.
    assert.equal(await source.quote("GBP", answering({ result: "success", rates: { USD: 1 } })), null);
  });

  const nonsense: [string, unknown][] = [
    ["null where the rate should be", { result: "success", rates: { NGN: null } }],
    ["zero", { result: "success", rates: { NGN: 0 } }],
    ["a string", { result: "success", rates: { NGN: "1327" } }],
    ["the pair inverted", { result: "success", rates: { NGN: 0.00075 } }],
    ["an error the provider called success-shaped", { result: "error", "error-type": "unsupported-code" }],
    ["no rates at all", { result: "success" }],
    ["not JSON", "<html>502 Bad Gateway</html>"],
  ];

  for (const [what, body] of nonsense) {
    it(`refuses ${what}`, async () => {
      assert.equal(await source.quote("USD", answering(body)), null);
    });
  }

  it("refuses a non-200, however good the body looks", async () => {
    assert.equal(
      await source.quote("USD", answering({ result: "success", rates: { NGN: 1327 } }, 503)),
      null,
    );
  });
});

describe("a rate pinned by hand", () => {
  it("uses the number from the environment, and asks nobody", async () => {
    const source = sourceFor("fixed", { USD: 1500, GBP: 1950 })!;
    const exploding = (() => {
      throw new Error("a fixed rate must not touch the network");
    }) as unknown as typeof fetch;

    assert.equal((await source.quote("USD", exploding))?.rate, 1500);
    assert.equal((await source.quote("GBP", exploding))?.rate, 1950);
  });

  it("has nothing to say about a currency nobody pinned", async () => {
    // Better than falling back to the feed: "fixed" was chosen deliberately,
    // and half-fixed rates would mean two invoices minutes apart priced from
    // two different sources with nothing on them to say which.
    const source = sourceFor("fixed", { USD: 1500 })!;
    assert.equal(await source.quote("GBP", fetch), null);
  });

  it("will not take an implausible one, even typed by hand", async () => {
    const source = sourceFor("fixed", { USD: 0.00075 })!;
    assert.equal(await source.quote("USD", fetch), null);
  });
});

describe("choosing a provider", () => {
  it("names the source, because the invoice records it", () => {
    assert.equal(sourceFor("open-er-api", NO_FIXED)!.name, "open.er-api.com");
    assert.equal(sourceFor("fixed", NO_FIXED)!.name, "fixed");
  });

  it("is null for a provider that does not exist", () => {
    // Configuration naming a provider nobody wrote. The caller logs and falls
    // back to the cache rather than inventing one.
    assert.equal(sourceFor("bloomberg", NO_FIXED), null);
    assert.equal(sourceFor("", NO_FIXED), null);
  });
});
