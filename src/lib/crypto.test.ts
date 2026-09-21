import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

// The module reads the key through config at call time, so setting it here is
// enough — no need for a separate environment file.
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encrypt, decrypt, safeEqual, verifyMetaSignature, verifyMonnifySignature, publicToken } =
  await import("./crypto.ts");

describe("encryption at rest", () => {
  it("round-trips an account number", () => {
    const acct = "0123456789";
    assert.equal(decrypt(encrypt(acct)), acct);
  });

  it("produces different ciphertext each time", () => {
    // Otherwise the column tells you two users share a bank account.
    const a = encrypt("0123456789");
    const b = encrypt("0123456789");
    assert.notEqual(a.toString("hex"), b.toString("hex"));
    assert.equal(decrypt(a), decrypt(b));
  });

  it("refuses tampered ciphertext", () => {
    const blob = encrypt("0123456789");
    // Corrupt the auth tag; GCM must refuse to decrypt at all.
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 0xff, blob.length - 1);
    assert.throws(() => decrypt(blob));
  });

  it("refuses a truncated blob", () => {
    assert.throws(() => decrypt(Buffer.alloc(4)));
  });
});

describe("safeEqual", () => {
  it("matches identical strings", () => assert.ok(safeEqual("abc", "abc")));
  it("rejects different strings", () => assert.ok(!safeEqual("abc", "abd")));
  it("rejects different lengths", () => assert.ok(!safeEqual("abc", "abcd")));
  it("rejects empty against non-empty", () => assert.ok(!safeEqual("", "a")));
});

describe("Meta webhook signature", () => {
  const secret = "app-secret";
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));
  const good = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

  it("accepts a correct signature", () => {
    assert.ok(verifyMetaSignature(raw, good, secret));
  });

  it("rejects a wrong secret", () => {
    assert.ok(!verifyMetaSignature(raw, good, "other-secret"));
  });

  it("rejects a body that changed by one byte", () => {
    const tampered = Buffer.from(JSON.stringify({ object: "whatsapp_business_accounT" }));
    assert.ok(!verifyMetaSignature(tampered, good, secret));
  });

  it("rejects a missing or unprefixed header", () => {
    assert.ok(!verifyMetaSignature(raw, undefined, secret));
    assert.ok(!verifyMetaSignature(raw, good.slice("sha256=".length), secret));
  });
});

describe("Monnify webhook signature", () => {
  const secret = "client-secret";
  const raw = Buffer.from('{"eventType":"SUCCESSFUL_TRANSACTION"}');
  const good = createHmac("sha512", secret).update(raw).digest("hex");

  it("accepts a correct signature", () => {
    assert.ok(verifyMonnifySignature(raw, good, secret));
  });

  it("rejects a wrong one", () => {
    assert.ok(!verifyMonnifySignature(raw, "deadbeef", secret));
    assert.ok(!verifyMonnifySignature(raw, undefined, secret));
  });
});

describe("public tokens", () => {
  it("are URL-safe and unguessable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = publicToken();
      assert.match(t, /^[A-Za-z0-9_-]+$/);
      assert.ok(t.length >= 20, `token too short: ${t}`);
      assert.ok(!seen.has(t), "token repeated");
      seen.add(t);
    }
  });
});
