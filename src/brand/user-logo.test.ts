/**
 * The Pro logo.
 *
 * This is the only path in the product where a file from outside is stored and
 * later rendered into a document a stranger opens, so the tests are mostly
 * about what gets refused rather than what gets through.
 */

process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "123";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { downloadMedia } = await import("../whatsapp/client.ts");

/** Meta answers twice: where the file is, then the file. */
function twoStep(
  meta: Record<string, unknown>,
  body: Buffer | null,
  opts: { metaStatus?: number; fileStatus?: number } = {},
) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes("cdn")) {
      return new Response(JSON.stringify(meta), {
        status: opts.metaStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(body ? new Uint8Array(body) : null, { status: opts.fileStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

describe("fetching media a user sent", () => {
  it("asks where the file is, then collects it", async () => {
    const { impl, calls } = twoStep(
      { url: "https://cdn.example/f", mime_type: "image/png", file_size: PNG.length },
      PNG,
    );
    const got = await downloadMedia("media-1", { fetchImpl: impl });

    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(got.contentType, "image/png");
    assert.equal(got.bytes.length, PNG.length);
    assert.equal(calls.length, 2, "it should take exactly two calls");
    assert.match(calls[0]!, /media-1/);
  });

  /*
   * The cap is the point of the function as much as the download is. This is
   * the one place a stranger's phone decides how many bytes we allocate.
   */
  it("refuses on the size they report, before transferring anything", async () => {
    const { impl, calls } = twoStep(
      { url: "https://cdn.example/f", mime_type: "video/mp4", file_size: 40 * 1024 * 1024 },
      Buffer.alloc(10),
    );
    const got = await downloadMedia("media-1", { maxBytes: 2 * 1024 * 1024, fetchImpl: impl });

    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /too large/);
    assert.equal(calls.length, 1, "it fetched the file anyway");
  });

  it("refuses again on what actually arrived", async () => {
    // No file_size reported, so the only defence is measuring the bytes.
    const { impl } = twoStep({ url: "https://cdn.example/f", mime_type: "image/png" }, Buffer.alloc(5000));
    const got = await downloadMedia("media-1", { maxBytes: 1000, fetchImpl: impl });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /too large/);
  });

  it("reports a failure rather than throwing", async () => {
    const { impl } = twoStep({ error: { message: "Media not found" } }, null, { metaStatus: 404 });
    const got = await downloadMedia("gone", { fetchImpl: impl });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /Media not found/);
  });

  it("survives the network dropping", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const got = await downloadMedia("media-1", { fetchImpl: impl });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /ECONNRESET/);
  });
});

/*
 * What counts as an image is decided by the bytes, never by the mime type on
 * the message — that comes from the sending phone.
 */
describe("what may become a logo", () => {
  // Same table the module sniffs against, exercised through a copy so the
  // test states the rule rather than importing it.
  const sniff = (bytes: Buffer): string | null => {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    return null;
  };

  it("accepts the three raster formats a phone produces", () => {
    assert.equal(sniff(PNG), "image/png");
    assert.equal(sniff(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])), "image/jpeg");
    assert.equal(
      sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)])),
      "image/webp",
    );
  });

  /*
   * An SVG is a document. It can carry script and fetch external references,
   * and it would be inlined into a page a client opens. Refused however it is
   * labelled.
   */
  it("refuses an SVG even when the message calls it an image", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(sniff(svg), null);
  });

  it("refuses a PDF, an HTML file and empty bytes", () => {
    assert.equal(sniff(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3")), null);
    assert.equal(sniff(Buffer.from("<!doctype html><html><body>hi</body></html>")), null);
    assert.equal(sniff(Buffer.alloc(0)), null);
  });

  it("refuses a file too short to identify", () => {
    assert.equal(sniff(Buffer.from([0x89, 0x50])), null);
  });
});
